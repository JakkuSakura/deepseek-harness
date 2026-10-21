/** OpenID Connect discovery, authorization-code exchange, and ID-token claims. */

import { randomBytes } from 'node:crypto'
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'

const DISCOVERY_CACHE_MILLISECONDS = 5 * 60 * 1000
const JWKS_COOLDOWN_MILLISECONDS = 30 * 1000
const JWKS_CACHE_MILLISECONDS = 10 * 60 * 1000

/** Provider endpoints resolved from one OpenID Connect discovery document. */
export interface OidcDiscovery {
  /** Canonical issuer, as the provider states it. */
  readonly issuer: string
  /** Authorization-code endpoint the browser is sent to. */
  readonly authorizationEndpoint: string
  /** Token endpoint the callback posts to. */
  readonly tokenEndpoint: string
  /** JSON Web Key Set URL used to verify ID tokens. */
  readonly jwksUri: string
  /** Optional UserInfo endpoint used when a provider releases no ID token. */
  readonly userinfoEndpoint?: string
}

/** Claims this gate consumes from an ID token or UserInfo response. */
export interface OidcClaims {
  /** Provider subject identifier. */
  readonly subject: string
  /** Provider email claim, when released. */
  readonly email?: string
  /** Whether the provider marked the email verified; absent when unreported. */
  readonly emailVerified?: boolean
  /** Provider display name, when released. */
  readonly name?: string
  /** Nonce bound to the authorization request, when present. */
  readonly nonce?: string
}

/** Configuration required to talk to one provider. */
export interface OidcClientOptions {
  /** Provider issuer URL. */
  readonly issuer: string
  /** Registered client id. */
  readonly clientId: string
  /** Registered client secret; omitted for a public PKCE client. */
  readonly clientSecret?: string
  /** Per-operation secret lookup; takes precedence over {@link clientSecret}. */
  readonly resolveClientSecret?: () => Promise<string | undefined>
  /** Scopes requested from the provider. */
  readonly scopes: readonly string[]
  /** Deadline for each provider HTTP call in milliseconds. */
  readonly requestTimeoutMs: number
  /** Transport override for tests; defaults to the process fetch. */
  readonly fetch?: typeof fetch
}

/** One authorization request built from a state, nonce, and PKCE verifier. */
export interface AuthorizationRequest {
  /** Absolute provider URL the browser is redirected to. */
  readonly url: string
  /** Nonce that the ID token must echo. */
  readonly nonce: string
}

/** One authorization-code redemption. */
export interface CodeExchange {
  /** Authorization code from the callback query. */
  readonly code: string
  /** PKCE verifier retained with the authorization state. */
  readonly codeVerifier: string
  /** Exact redirect URI used for the authorization request. */
  readonly redirectUri: string
  /** Nonce retained with the authorization state. */
  readonly nonce: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`host-oauth: discovery document has no ${field}`)
  }
  return value
}

function optionalUrl(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') {
    throw new Error(`host-oauth: discovery document has an invalid ${field}`)
  }
  return absoluteUrl(value, field)
}

function absoluteUrl(value: string, field: string): string {
  try {
    return new URL(value).href
  } catch {
    throw new Error(`host-oauth: discovery document has an invalid ${field}`)
  }
}

function parseDiscovery(value: unknown): OidcDiscovery {
  if (!isRecord(value)) throw new Error('host-oauth: discovery document is not a JSON object')
  const userinfoEndpoint = optionalUrl(value, 'userinfo_endpoint')
  return {
    issuer: requiredString(value, 'issuer'),
    authorizationEndpoint: absoluteUrl(requiredString(value, 'authorization_endpoint'), 'authorization_endpoint'),
    tokenEndpoint: absoluteUrl(requiredString(value, 'token_endpoint'), 'token_endpoint'),
    jwksUri: absoluteUrl(requiredString(value, 'jwks_uri'), 'jwks_uri'),
    ...userinfoEndpoint === undefined ? {} : { userinfoEndpoint },
  }
}

function parseClaims(value: unknown): OidcClaims {
  if (!isRecord(value) || typeof value.sub !== 'string' || value.sub === '') {
    throw new Error('host-oauth: provider response carried no subject')
  }
  const email = typeof value.email === 'string' ? value.email : undefined
  const emailVerified = typeof value.email_verified === 'boolean' ? value.email_verified : undefined
  const name = typeof value.name === 'string' ? value.name : undefined
  const nonce = typeof value.nonce === 'string' ? value.nonce : undefined
  return {
    subject: value.sub,
    ...email === undefined ? {} : { email },
    ...emailVerified === undefined ? {} : { emailVerified },
    ...name === undefined ? {} : { name },
    ...nonce === undefined ? {} : { nonce },
  }
}

/** Remove a trailing slash so one issuer spelling maps to one discovery URL. */
function withoutTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

/** OpenID Connect client owned by one plugin activation. */
export class OidcClient {
  private readonly issuer: string
  private readonly clientId: string
  private readonly clientSecret: string | undefined
  private readonly resolveClientSecret: (() => Promise<string | undefined>) | undefined
  private readonly scopes: readonly string[]
  private readonly requestTimeoutMs: number
  private readonly transport: typeof fetch
  private discovery: { readonly value: OidcDiscovery; readonly expiresAt: number } | undefined
  private pendingDiscovery: Promise<OidcDiscovery> | undefined
  private jwks: ReturnType<typeof createRemoteJWKSet> | undefined

  /**
   * @param options - issuer, client registration, scopes, and timeout.
   */
  constructor(options: OidcClientOptions) {
    this.issuer = withoutTrailingSlash(options.issuer)
    this.clientId = options.clientId
    this.clientSecret = options.clientSecret
    this.resolveClientSecret = options.resolveClientSecret
    this.scopes = options.scopes
    this.requestTimeoutMs = options.requestTimeoutMs
    const transport = options.fetch ?? globalThis.fetch
    this.transport = (input, init) => transport(input, init)
  }

  /**
   * Read and cache the provider discovery document.
   * @returns resolved provider endpoints.
   */
  async discover(): Promise<OidcDiscovery> {
    const cached = this.discovery
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value
    if (this.pendingDiscovery !== undefined) return this.pendingDiscovery
    const pending = this.loadDiscovery()
    this.pendingDiscovery = pending
    try {
      return await pending
    } finally {
      this.pendingDiscovery = undefined
    }
  }

  /**
   * Build one authorization URL with PKCE and a fresh nonce.
   * @param redirectUri - absolute callback URL registered with the provider.
   * @param state - opaque correlation value stored server-side.
   * @param codeChallenge - S256 PKCE challenge.
   * @param prompt - optional provider prompt such as `select_account`.
   * @returns absolute authorization URL and the nonce retained for verification.
   */
  async authorizationUrl(
    redirectUri: string,
    state: string,
    codeChallenge: string,
    prompt: string | undefined,
  ): Promise<AuthorizationRequest> {
    const discovery = await this.discover()
    const nonce = randomToken()
    const url = new URL(discovery.authorizationEndpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', this.scopes.join(' '))
    url.searchParams.set('state', state)
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('code_challenge', codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    if (prompt !== undefined) url.searchParams.set('prompt', prompt)
    return { url: url.href, nonce }
  }

  /**
   * Redeem one authorization code and verify the resulting identity.
   * @param exchange - code, PKCE verifier, redirect URI, and expected nonce.
   * @returns verified provider claims.
   */
  async exchange(exchange: CodeExchange): Promise<OidcClaims> {
    const discovery = await this.discover()
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: exchange.code,
      redirect_uri: exchange.redirectUri,
      code_verifier: exchange.codeVerifier,
      client_id: this.clientId,
    })
    /* v8 ignore next 4 -- public and confidential clients both exercise this branch; v8 misattributes the awaited resolver */
    const clientSecret = this.resolveClientSecret === undefined
      ? this.clientSecret
      : await this.resolveClientSecret()
    /* v8 ignore next -- public and confidential clients both exercise this branch; v8 misattributes it after an await */
    if (clientSecret !== undefined) body.set('client_secret', clientSecret)
    const tokenResponse = await this.fetchJson(discovery.tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'accept': 'application/json',
      },
      body,
    })
    if (!isRecord(tokenResponse)) throw new Error('host-oauth: token endpoint returned an invalid response')
    const idToken = typeof tokenResponse.id_token === 'string' ? tokenResponse.id_token : undefined
    const accessToken = typeof tokenResponse.access_token === 'string' ? tokenResponse.access_token : undefined
    if (idToken !== undefined) {
      const verified = await this.verifyIdToken(discovery, idToken, exchange.nonce)
      if (verified.email === undefined && accessToken !== undefined && discovery.userinfoEndpoint !== undefined) {
        return await this.readUserinfo(discovery.userinfoEndpoint, accessToken)
      }
      return verified
    }
    if (accessToken === undefined || discovery.userinfoEndpoint === undefined) {
      throw new Error('host-oauth: token endpoint returned neither an ID token nor a usable UserInfo endpoint')
    }
    return await this.readUserinfo(discovery.userinfoEndpoint, accessToken)
  }

  private async loadDiscovery(): Promise<OidcDiscovery> {
    const url = `${this.issuer}/.well-known/openid-configuration`
    let value: unknown
    try {
      value = await this.fetchJson(url, { headers: { accept: 'application/json' } })
    } catch (error) {
      throw new Error(`host-oauth: cannot read provider discovery at ${this.issuer}`, { cause: error })
    }
    const discovery = parseDiscovery(value)
    this.discovery = { value: discovery, expiresAt: Date.now() + DISCOVERY_CACHE_MILLISECONDS }
    return discovery
  }

  private async verifyIdToken(discovery: OidcDiscovery, idToken: string, nonce: string): Promise<OidcClaims> {
    this.jwks ??= createRemoteJWKSet(new URL(discovery.jwksUri), {
      timeoutDuration: this.requestTimeoutMs,
      cooldownDuration: JWKS_COOLDOWN_MILLISECONDS,
      cacheMaxAge: JWKS_CACHE_MILLISECONDS,
      [customFetch]: this.transport,
    })
    const verified = await jwtVerify(idToken, this.jwks, {
      issuer: discovery.issuer,
      audience: this.clientId,
    })
    const claims = parseClaims(verified.payload)
    if (claims.nonce !== nonce) throw new Error('host-oauth: ID token did not echo the authorization nonce')
    return claims
  }

  private async readUserinfo(endpoint: string, accessToken: string): Promise<OidcClaims> {
    return parseClaims(await this.fetchJson(endpoint, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    }))
  }

  private async fetchJson(url: string, init: RequestInit): Promise<unknown> {
    const target = new URL(url)
    let response: Response
    try {
      response = await this.transport(url, { ...init, signal: AbortSignal.timeout(this.requestTimeoutMs) })
    } catch (error) {
      throw new Error(`host-oauth: ${target.host} is unreachable`, { cause: error })
    }
    if (!response.ok) throw new Error(`host-oauth: ${target.host} answered HTTP ${String(response.status)}`)
    try {
      return await response.json()
    } catch (error) {
      throw new Error(`host-oauth: ${target.host} returned invalid JSON`, { cause: error })
    }
  }
}

/**
 * Generate an unguessable token for state or nonce values.
 * @returns 32 random bytes as base64url text.
 */
export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}
