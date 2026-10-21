/**
 * @deepseek-ai/dsh-host-oauth — OpenID Connect login gate for the Web host.
 * It runs the authorization-code flow with PKCE, admits only identities on an
 * email, domain, or subject whitelist, and mints an authority-bound browser
 * session cookie that Connection accepts in place of the process launch token.
 * Mounting the gate retires the launch token, so this sign-in is the only way
 * into the deployment.
 * The gate owns `/auth/*` routes: login, callback, logout, and a session
 * probe. It requires a `webServer`, the Connection carrier it registers a
 * browser authenticator with, and the credential provider holding its signing
 * secret and optional client secret.
 * @module @deepseek-ai/dsh-host-oauth
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { BrowserSessionAuthenticator } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { OidcClient, randomToken } from './oidc.ts'
import type { OidcClaims } from './oidc.ts'
import { OAuthSessionStore, readCookie, serializeCookie } from './session.ts'
import type { SessionIdentity } from './session.ts'
import { hasWhitelistEntry, identityAllowed, identityWhitelist } from './whitelist.ts'
import type { IdentityWhitelist } from './whitelist.ts'

/** Stable Cordis plugin name. */
export const name = 'host-oauth'

/** Services required before the gate can mount. */
export const inject = ['webServer', 'connection', 'credentials']

/** OpenID Connect login gate configuration. */
export interface Config {
  /** Provider issuer URL, e.g. `https://kc.example.com/realms/main`; absent disables the gate. */
  issuer?: string
  /** Registered client id; required when {@link issuer} is present. */
  clientId?: string
  /** Credential reference holding the client secret; required for confidential clients. */
  clientSecretRef?: string
  /** Requested scopes. @default ['openid', 'email', 'profile'] */
  scopes?: string[]
  /** Exact email addresses admitted. */
  allowedEmails?: string[]
  /** Exact email domains admitted, without a leading `@`. */
  allowedDomains?: string[]
  /** Exact provider subject identifiers admitted. */
  allowedSubjects?: string[]
  /** Absolute session lifetime in days. @default 30 */
  sessionMaxAgeDays?: number
  /** Advertised HTTP(S) application root used in the callback URL behind a prefix-stripping proxy. */
  publicUrl?: string
  /** Base session cookie name. @default 'dsh-oauth' */
  cookieName?: string
  /** Login route. @default '/auth/login' */
  loginPath?: string
  /** Provider callback route. @default '/auth/callback' */
  callbackPath?: string
  /** Logout route. @default '/auth/logout' */
  logoutPath?: string
  /** Session probe route. @default '/auth/session' */
  sessionPath?: string
  /** Deadline for each provider HTTP call in milliseconds. @default 10000 */
  requestTimeoutMs?: number
}

interface ResolvedConfig extends Config {
  issuer: string
  clientId: string
  scopes: string[]
  allowedEmails: string[]
  allowedDomains: string[]
  allowedSubjects: string[]
  sessionMaxAgeDays: number
  cookieName: string
  loginPath: string
  callbackPath: string
  logoutPath: string
  sessionPath: string
  requestTimeoutMs: number
}

const DEFAULT_SCOPES = ['openid', 'email', 'profile']
const DEFAULT_COOKIE_NAME = 'dsh-oauth'
const DEFAULT_LOGIN_PATH = '/auth/login'
const DEFAULT_CALLBACK_PATH = '/auth/callback'
const DEFAULT_LOGOUT_PATH = '/auth/logout'
const DEFAULT_SESSION_PATH = '/auth/session'
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const STATE_MAX_AGE_SECONDS = 10 * 60
const PENDING_LIMIT = 256
const PROMPTS = new Set(['none', 'login', 'consent', 'select_account'])
const ROUTE_FIELDS = ['loginPath', 'callbackPath', 'logoutPath', 'sessionPath'] as const

export const Config: z<Config> = z.object({
  issuer: z.string(),
  clientId: z.string(),
  clientSecretRef: z.string(),
  scopes: z.array(String).default([...DEFAULT_SCOPES]),
  allowedEmails: z.array(String).default([]),
  allowedDomains: z.array(String).default([]),
  allowedSubjects: z.array(String).default([]),
  sessionMaxAgeDays: z.natural().min(1).default(30),
  publicUrl: z.string(),
  cookieName: z.string().default(DEFAULT_COOKIE_NAME),
  loginPath: z.string().default(DEFAULT_LOGIN_PATH),
  callbackPath: z.string().default(DEFAULT_CALLBACK_PATH),
  logoutPath: z.string().default(DEFAULT_LOGOUT_PATH),
  sessionPath: z.string().default(DEFAULT_SESSION_PATH),
  requestTimeoutMs: z.natural().min(1).default(DEFAULT_REQUEST_TIMEOUT_MS),
})

interface PendingAuthorization {
  readonly authority: string
  readonly verifier: string
  readonly nonce: string
  readonly redirectUri: string
  readonly redirectTo: string
  readonly expiresAt: number
}

interface RouteFacts {
  readonly authority: string
  readonly secure: boolean
}

function headerValue(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
}

/** Canonical request authority used as the cookie scope and redirect origin. */
function requestAuthority(headers: IncomingMessage['headers']): string | undefined {
  const host = headerValue(headers, 'host')
  if (host === undefined) return undefined
  try {
    return new URL(`http://${host}`).host
  } catch {
    return undefined
  }
}

function requestFacts(req: IncomingMessage): RouteFacts | undefined {
  const authority = requestAuthority(req.headers)
  if (authority === undefined) return undefined
  const forwarded = headerValue(req.headers, 'x-forwarded-proto')?.split(',', 1)[0]?.trim().toLowerCase()
  return { authority, secure: forwarded === 'https' }
}

function requestUrl(req: IncomingMessage): URL {
  /* v8 ignore next -- node:http always supplies url on server requests. */
  return new URL(req.url ?? '/', 'http://dsh.invalid')
}

/** One same-origin path, refusing absolute URLs and protocol-relative forms. */
function safeRedirect(value: string | undefined): string {
  if (value === undefined || value === '' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return '/'
  }
  return value
}

function routePath(value: string, field: string): string {
  if (!value.startsWith('/') || value.endsWith('/') || value.includes('?') || value.includes('#')) {
    throw new Error(`host-oauth: ${field} must be an absolute route path without a trailing slash`)
  }
  return value
}

function absoluteHttpUrl(value: string, field: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`host-oauth: ${field} must be an absolute HTTP(S) URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`host-oauth: ${field} must be an absolute HTTP(S) URL`)
  }
  return url
}

function resolveConfig(config: Config & { readonly issuer: string }): ResolvedConfig {
  // The plugin Config schema supplies every default at load; this step is the
  // cross-field validation the schema cannot express.
  if (config.clientId === undefined) throw new Error('host-oauth: clientId is required')
  const resolved = Object.assign({}, config, { clientId: config.clientId }) as ResolvedConfig
  absoluteHttpUrl(resolved.issuer, 'issuer')
  if (!/^[A-Za-z0-9_-]+$/u.test(resolved.cookieName)) {
    throw new Error('host-oauth: cookieName must contain only letters, digits, hyphens, and underscores')
  }
  const paths = ROUTE_FIELDS.map(field => routePath(resolved[field], field))
  if (new Set(paths).size !== paths.length) throw new Error('host-oauth: auth route paths must be distinct')
  if (resolved.publicUrl !== undefined) absoluteHttpUrl(resolved.publicUrl, 'publicUrl')
  if (resolved.clientSecretRef !== undefined && !isCredentialRefName(resolved.clientSecretRef)) {
    throw new Error('host-oauth: clientSecretRef must be an environment-variable name')
  }
  if (resolved.scopes.length === 0 || resolved.scopes.some(scope => scope.trim() === '')) {
    throw new Error('host-oauth: scopes must not be empty')
  }
  if (!hasWhitelistEntry(whitelistOf(resolved))) {
    throw new Error('host-oauth: at least one of allowedEmails, allowedDomains, or allowedSubjects is required')
  }
  return resolved
}

function whitelistOf(config: ResolvedConfig): IdentityWhitelist {
  return identityWhitelist({
    emails: config.allowedEmails,
    domains: config.allowedDomains,
    subjects: config.allowedSubjects,
  })
}

function identityClaims(identity: SessionIdentity): OidcClaims {
  return {
    subject: identity.subject,
    ...identity.email === undefined ? {} : { email: identity.email },
  }
}

function sessionIdentity(claims: OidcClaims): SessionIdentity {
  return {
    subject: claims.subject,
    ...claims.email === undefined ? {} : { email: claims.email },
    ...claims.name === undefined ? {} : { name: claims.name },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function writeText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
  })
  res.end(body)
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(value))
}

function writeRedirect(res: ServerResponse, location: string, cookies: readonly string[] = []): void {
  const headers: Record<string, string | string[]> = {
    'cache-control': 'no-store',
    'location': location,
  }
  const [first, ...rest] = cookies
  if (first !== undefined) headers['set-cookie'] = rest.length === 0 ? first : [first, ...rest]
  res.writeHead(303, headers)
  res.end()
}

/**
 * Mount the login gate: discovery-backed authorization routes, the Connection
 * browser authenticator, and the session probe.
 * @param ctx - plugin context carrying webServer, connection, and credentials.
 * @param config - validated {@link Config}.
 * @returns after the signing secret, routes, and authenticator are installed.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // The row is always mounted; an invocation without --oauth-issuer leaves the
  // gate inert so no launch-token behavior changes.
  if (config.issuer === undefined) {
    if (config.clientId !== undefined) throw new Error('host-oauth: clientId requires issuer')
    return
  }
  const resolved = resolveConfig(config as Config & { readonly issuer: string })
  const whitelist = whitelistOf(resolved)
  const stateCookieBase = `${resolved.cookieName}-state`
  const pending = new Map<string, PendingAuthorization>()
  const currentStore = await OAuthSessionStore.create(ctx.credentials, {
    cookieName: resolved.cookieName,
    maxAgeDays: resolved.sessionMaxAgeDays,
  })
  const stateCookieName = (authority: string): string =>
    `${stateCookieBase}-${createHash('sha256').update(authority).digest('base64url').slice(0, 22)}`
  const clientSecretRef: CredentialRef | undefined = resolved.clientSecretRef === undefined
    ? undefined
    : credentialRef(resolved.clientSecretRef)
  const oidc = new OidcClient({
    issuer: resolved.issuer,
    clientId: resolved.clientId,
    scopes: resolved.scopes,
    requestTimeoutMs: resolved.requestTimeoutMs,
    ...clientSecretRef === undefined
      ? {}
      : {
        resolveClientSecret: async (): Promise<string | undefined> =>
          (await ctx.credentials.resolve(clientSecretRef))?.value,
      },
  })

  const appRoot = (facts: RouteFacts): string => {
    if (resolved.publicUrl !== undefined) {
      const url = new URL(resolved.publicUrl)
      return url.href.endsWith('/') ? url.href : `${url.href}/`
    }
    return `${facts.secure ? 'https' : 'http'}://${facts.authority}/`
  }

  /** Absolute route URL, preserving an advertised mount prefix. */
  const actionUrl = (facts: RouteFacts, path: string): string =>
    new URL(path.replace(/^\//u, ''), appRoot(facts)).href

  const readIdentity = (authority: string, cookie: string | undefined): SessionIdentity | undefined =>
    currentStore.read(authority, cookie)

  const isAuthorized = (req: IncomingMessage, facts: RouteFacts): boolean => {
    const identity = readIdentity(facts.authority, headerValue(req.headers, 'cookie'))
    return identity !== undefined && identityAllowed(whitelist, identityClaims(identity))
  }

  function prunePending(): void {
    const now = Date.now()
    for (const [state, entry] of pending) {
      if (entry.expiresAt <= now) pending.delete(state)
    }
    while (pending.size >= PENDING_LIMIT) {
      const oldest = pending.keys().next().value
      /* v8 ignore next -- the map is non-empty inside this loop */
      if (oldest === undefined) break
      pending.delete(oldest)
    }
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const facts = requestFacts(req)
    if (facts === undefined) {
      writeText(res, 400, 'host-oauth: request has no Host authority\n')
      return
    }
    const url = requestUrl(req)
    const redirectTo = safeRedirect(url.searchParams.get('rd') ?? undefined)
    if (isAuthorized(req, facts)) {
      writeRedirect(res, redirectTo)
      return
    }
    const state = randomToken()
    const verifier = randomToken()
    const redirectUri = actionUrl(facts, resolved.callbackPath)
    const promptValue = url.searchParams.get('prompt')
    const prompt = promptValue !== null && PROMPTS.has(promptValue) ? promptValue : undefined
    let authorization
    try {
      authorization = await oidc.authorizationUrl(
        redirectUri,
        state,
        createHash('sha256').update(verifier).digest('base64url'),
        prompt,
      )
    } catch (error) {
      ctx.logger.warn(`host-oauth: cannot start sign-in: ${errorMessage(error)}`)
      writeText(res, 503, 'host-oauth: the identity provider is unavailable\n')
      return
    }
    prunePending()
    pending.set(state, {
      authority: facts.authority,
      verifier,
      nonce: authorization.nonce,
      redirectUri,
      redirectTo,
      expiresAt: Date.now() + STATE_MAX_AGE_SECONDS * 1000,
    })
    writeRedirect(res, authorization.url, [
      serializeCookie(stateCookieName(facts.authority), state, STATE_MAX_AGE_SECONDS, facts.secure),
    ])
  }

  async function handleCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const facts = requestFacts(req)
    if (facts === undefined) {
      writeText(res, 400, 'host-oauth: request has no Host authority\n')
      return
    }
    const url = requestUrl(req)
    const state = url.searchParams.get('state')
    const cookieHeader = headerValue(req.headers, 'cookie')
    const cookieName = stateCookieName(facts.authority)
    const stateCookie = cookieHeader === undefined ? undefined : readCookie(cookieHeader, cookieName)
    const clearState = serializeCookie(cookieName, '', 0, facts.secure)
    const entry = state === null ? undefined : pending.get(state)
    if (state === null || entry === undefined || entry.expiresAt <= Date.now()
      || entry.authority !== facts.authority || stateCookie !== state) {
      if (state !== null) pending.delete(state)
      writeText(res, 400, 'host-oauth: sign-in state is missing or expired\n')
      return
    }
    pending.delete(state)
    if (url.searchParams.get('error') !== null) {
      writeRedirect(res, entry.redirectTo, [clearState])
      return
    }
    const code = url.searchParams.get('code')
    if (code === null) {
      writeText(res, 400, 'host-oauth: sign-in callback carried no authorization code\n')
      return
    }
    let claims: OidcClaims
    try {
      claims = await oidc.exchange({
        code,
        codeVerifier: entry.verifier,
        redirectUri: entry.redirectUri,
        nonce: entry.nonce,
      })
    } catch (error) {
      ctx.logger.warn(`host-oauth: sign-in failed: ${errorMessage(error)}`)
      writeText(res, 401, 'host-oauth: single sign-on failed\n')
      return
    }
    if (!identityAllowed(whitelist, claims)) {
      writeText(res, 403, 'host-oauth: this identity is not allowed to use this host\n')
      return
    }
    const cookie = currentStore.mint(facts.authority, sessionIdentity(claims), facts.secure)
    writeRedirect(res, entry.redirectTo, [cookie.header, clearState])
  }

  function handleLogout(req: IncomingMessage, res: ServerResponse): void {
    const facts = requestFacts(req)
    if (facts === undefined) {
      writeText(res, 400, 'host-oauth: request has no Host authority\n')
      return
    }
    writeRedirect(res, safeRedirect(requestUrl(req).searchParams.get('rd') ?? undefined), [
      currentStore.clear(facts.authority, facts.secure),
    ])
  }

  function handleSession(req: IncomingMessage, res: ServerResponse): void {
    const facts = requestFacts(req)
    if (facts === undefined) {
      writeText(res, 400, 'host-oauth: request has no Host authority\n')
      return
    }
    const identity = readIdentity(facts.authority, headerValue(req.headers, 'cookie'))
    if (identity === undefined) {
      writeJson(res, 200, { authenticated: false })
      return
    }
    writeJson(res, 200, {
      authenticated: true,
      subject: identity.subject,
      ...identity.email === undefined ? {} : { email: identity.email },
      ...identity.name === undefined ? {} : { name: identity.name },
    })
  }

  function guarded(
    req: IncomingMessage,
    res: ServerResponse,
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ): void {
    try {
      const result = handler(req, res)
      if (result !== undefined) {
        void result.catch((error: unknown) => {
          ctx.logger.warn(`host-oauth: request failed: ${errorMessage(error)}`)
          if (!res.headersSent) writeText(res, 500, 'host-oauth: internal error\n')
          /* v8 ignore next -- a handler that already wrote owns the socket */
          else res.end()
        })
      }
    } catch (error) {
      ctx.logger.warn(`host-oauth: request failed: ${errorMessage(error)}`)
      if (!res.headersSent) writeText(res, 500, 'host-oauth: internal error\n')
      else res.end()
    }
  }

  const authenticator: BrowserSessionAuthenticator = {
    isAuthenticated(request) {
      const headers = request.headers
      const host = headers instanceof Headers ? headers.get('host') : headers.host
      const cookieHeader = headers instanceof Headers ? headers.get('cookie') : headers.cookie
      if (typeof host !== 'string' || host === '') return false
      let authority: string
      try {
        authority = new URL(`http://${host}`).host
      } catch {
        return false
      }
      const identity = readIdentity(authority, typeof cookieHeader === 'string' ? cookieHeader : undefined)
      return identity !== undefined && identityAllowed(whitelist, identityClaims(identity))
    },
    authorizeIndex(request, response) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return false
      const url = new URL(request.url ?? '/', 'http://dsh.invalid')
      response.writeHead(303, {
        'cache-control': 'no-store',
        'location': `${resolved.loginPath}?rd=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
      })
      response.end()
      return true
    },
  }

  const routes: readonly WebRoute[] = [
    { kind: 'exact', path: resolved.loginPath, handler: (req, res) => { guarded(req, res, handleLogin) } },
    { kind: 'exact', path: resolved.callbackPath, handler: (req, res) => { guarded(req, res, handleCallback) } },
    { kind: 'exact', path: resolved.logoutPath, handler: (req, res) => { guarded(req, res, handleLogout) } },
    { kind: 'exact', path: resolved.sessionPath, handler: (req, res) => { guarded(req, res, handleSession) } },
  ]

  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register(route), `host-oauth: ${route.path}`)
  }
  ctx.effect(() => ctx.connection.registerBrowserAuthenticator(authenticator), 'host-oauth: browser authenticator')
  ctx.effect(() => ctx.connection.retireLaunchToken(), 'host-oauth: launch token retired')
}
