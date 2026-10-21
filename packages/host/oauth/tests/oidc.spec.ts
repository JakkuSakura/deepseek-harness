/** OpenID Connect client: discovery, authorization URL, code exchange, and failure paths. */

import { describe, expect, it, vi } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { OidcClient, randomToken } from '../src/oidc.ts'

const ISSUER = 'https://idp.example'
const CLIENT_ID = 'dsh'
const CLIENT_SECRET = 'secret'

interface Provider {
  readonly transport: typeof fetch
  readonly discoveryCalls: () => number
  readonly authorizationCalls: string[]
  readonly signedKey: CryptoKey
  readonly publicJwk: Record<string, unknown>
  readonly setClaims: (claims: Record<string, unknown>) => void
  readonly setIdToken: (value: boolean) => void
  readonly setNonce: (value: string) => void
}

async function provider(): Promise<Provider> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const publicJwk = { ...await exportJWK(publicKey), kid: 'k1', alg: 'RS256', use: 'sig' }
  const state = {
    claims: { email: 'user@example.com', email_verified: true, name: 'User' } as Record<string, unknown>,
    idToken: true,
    nonce: '',
    discovery: 0,
    tokenCalls: 0,
    userinfoCalls: 0,
  }
  const authorizationCalls: string[] = []
  const json = (value: unknown): Response => Response.json(value)
  const transport: typeof fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === '/.well-known/openid-configuration') {
      state.discovery += 1
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
      })
    }
    if (url.pathname === '/jwks') return json({ keys: [publicJwk] })
    if (url.pathname === '/authorize') {
      authorizationCalls.push(url.href)
      return json({})
    }
    if (url.pathname === '/token') {
      state.tokenCalls += 1
      const body = {
        access_token: 'access',
        token_type: 'Bearer',
      } as Record<string, unknown>
      if (state.idToken) {
        body.id_token = await new SignJWT({ ...state.claims, nonce: state.nonce })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setSubject('subject-1')
          .setIssuer(ISSUER)
          .setAudience(CLIENT_ID)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey)
      }
      return json(body)
    }
    if (url.pathname === '/userinfo') {
      state.userinfoCalls += 1
      return json({ sub: 'subject-1', email: 'user@example.com', email_verified: true })
    }
    return new Response('not found', { status: 404 })
  }
  return {
    transport,
    discoveryCalls: () => state.discovery,
    authorizationCalls,
    signedKey: privateKey,
    publicJwk,
    setClaims: (claims) => { state.claims = claims },
    setIdToken: (value) => { state.idToken = value },
    setNonce: (value) => { state.nonce = value },
  }
}

function client(transport: typeof fetch, overrides: Partial<ConstructorParameters<typeof OidcClient>[0]> = {}): OidcClient {
  return new OidcClient({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    scopes: ['openid', 'email'],
    requestTimeoutMs: 1000,
    fetch: transport,
    ...overrides,
  })
}

describe('OidcClient', () => {
  it('reads and caches discovery, including concurrent callers', async () => {
    const fake = await provider()
    const oidc = client(fake.transport)
    const [first, second] = await Promise.all([oidc.discover(), oidc.discover()])
    expect(first).toMatchObject({ issuer: ISSUER, userinfoEndpoint: `${ISSUER}/userinfo` })
    expect(second).toBe(first)
    expect(fake.discoveryCalls()).toBe(1)
    expect(await oidc.discover()).toBe(first)
    expect(fake.discoveryCalls()).toBe(1)
  })

  it('builds an authorization URL with PKCE, nonce, and an allowed prompt', async () => {
    const fake = await provider()
    const oidc = client(fake.transport)
    const request = await oidc.authorizationUrl('https://app.example/auth/callback', 'state-1', 'challenge-1', 'select_account')
    const url = new URL(request.url)
    expect(url.origin).toBe(ISSUER)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/auth/callback')
    expect(url.searchParams.get('scope')).toBe('openid email')
    expect(url.searchParams.get('state')).toBe('state-1')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('prompt')).toBe('select_account')
    expect(url.searchParams.get('nonce')).toBe(request.nonce)
  })

  it('verifies an ID token and returns its claims', async () => {
    const fake = await provider()
    const oidc = client(fake.transport)
    const authorization = await oidc.authorizationUrl('https://app.example/cb', 's', 'c', undefined)
    fake.setNonce(authorization.nonce)
    const claims = await oidc.exchange({
      code: 'code', codeVerifier: 'verifier', redirectUri: 'https://app.example/cb', nonce: authorization.nonce,
    })
    expect(claims).toEqual({
      subject: 'subject-1',
      email: 'user@example.com',
      emailVerified: true,
      name: 'User',
      nonce: authorization.nonce,
    })
  })

  it('falls back to UserInfo without an ID token', async () => {
    const fake = await provider()
    fake.setIdToken(false)
    const oidc = client(fake.transport)
    const claims = await oidc.exchange({
      code: 'code', codeVerifier: 'verifier', redirectUri: 'https://app.example/cb', nonce: 'n',
    })
    expect(claims).toMatchObject({ subject: 'subject-1', email: 'user@example.com' })
  })

  it('falls back to UserInfo when the ID token carries no email', async () => {
    const fake = await provider()
    const oidc = client(fake.transport)
    const authorization = await oidc.authorizationUrl('https://app.example/cb', 's', 'c', undefined)
    fake.setNonce(authorization.nonce)
    fake.setClaims({ name: 'No Email' })
    const claims = await oidc.exchange({
      code: 'code', codeVerifier: 'verifier', redirectUri: 'https://app.example/cb', nonce: authorization.nonce,
    })
    expect(claims.email).toBe('user@example.com')
  })

  it('resolves the client secret per exchange and omits it when unset', async () => {
    const fake = await provider()
    const resolveClientSecret = vi.fn(async () => 'rotated')
    const oidc = client(fake.transport, { resolveClientSecret })
    const authorization = await oidc.authorizationUrl('https://app.example/cb', 's', 'c', undefined)
    fake.setNonce(authorization.nonce)
    await oidc.exchange({
      code: 'code', codeVerifier: 'verifier', redirectUri: 'https://app.example/cb', nonce: authorization.nonce,
    })
    expect(resolveClientSecret).toHaveBeenCalledOnce()

    fake.setNonce('n')
    const publicClient = new OidcClient({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      scopes: ['openid', 'email'],
      requestTimeoutMs: 1000,
      fetch: fake.transport,
    })
    await publicClient.discover()
    await publicClient.exchange({
      code: 'code', codeVerifier: 'verifier', redirectUri: 'https://app.example/cb', nonce: 'n',
    })
  })

  it('rejects a nonce mismatch', async () => {
    const fake = await provider()
    const oidc = client(fake.transport)
    await expect(oidc.exchange({
      code: 'code', codeVerifier: 'verifier', redirectUri: 'https://app.example/cb', nonce: 'wrong',
    })).rejects.toThrow(/nonce/u)
  })

  it('rejects a token response that is not an object', async () => {
    const transport: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/.well-known/openid-configuration') {
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
        })
      }
      return Response.json([])
    }
    const oidc = client(transport)
    await expect(oidc.exchange({
      code: 'code', codeVerifier: 'v', redirectUri: 'https://app.example/cb', nonce: 'n',
    })).rejects.toThrow(/invalid response/u)
  })

  it('rejects a token response with neither an ID token nor a UserInfo endpoint', async () => {
    const transport: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/.well-known/openid-configuration') {
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
        })
      }
      return Response.json({ access_token: 'access' })
    }
    const oidc = client(transport)
    await expect(oidc.exchange({
      code: 'code', codeVerifier: 'v', redirectUri: 'https://app.example/cb', nonce: 'n',
    })).rejects.toThrow(/neither an ID token/u)
  })

  it('reports discovery failures without leaking provider bodies', async () => {
    const cases: ReadonlyArray<[typeof fetch, RegExp]> = [
      [async () => new Response('no', { status: 503 }), /discovery/u],
      [async () => new Response('not json', { status: 200 }), /discovery/u],
      [async () => { throw new Error('offline') }, /discovery/u],
      [async () => Response.json([]), /discovery document is not a JSON object/u],
      [async () => Response.json({ issuer: ISSUER }), /discovery/u],
      [async () => Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: 'not-a-url',
      }), /discovery/u],
      [async () => Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        userinfo_endpoint: 42,
      }), /discovery/u],
    ]
    for (const [transport, pattern] of cases) {
      await expect(client(transport).discover()).rejects.toThrow(pattern)
    }
  })

  it('rejects a token endpoint HTTP failure and malformed claims', async () => {
    const failing: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/.well-known/openid-configuration') {
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          userinfo_endpoint: `${ISSUER}/userinfo`,
        })
      }
      if (url.pathname === '/token') return Response.json({ access_token: 'access' })
      return Response.json({ email: 'no-subject@example.com' })
    }
    const oidc = client(failing)
    await expect(oidc.exchange({
      code: 'code', codeVerifier: 'v', redirectUri: 'https://app.example/cb', nonce: 'n',
    })).rejects.toThrow(/no subject/u)
  })

  it('normalizes a trailing-slash issuer', async () => {
    const fake = await provider()
    const oidc = client(fake.transport, { issuer: `${ISSUER}/` })
    expect(await oidc.discover()).toMatchObject({ issuer: ISSUER })
    expect(fake.discoveryCalls()).toBe(1)
  })

  it('verifies an ID token when the token response carries no access token', async () => {
    const fake = await provider()
    const idToken = await new SignJWT({ nonce: 'n', email: 'user@example.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setSubject('subject-1')
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(fake.signedKey)
    const transport: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/.well-known/openid-configuration') {
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          userinfo_endpoint: `${ISSUER}/userinfo`,
        })
      }
      if (url.pathname === '/jwks') return Response.json({ keys: [fake.publicJwk] })
      return Response.json({ id_token: idToken })
    }
    const oidc = client(transport)
    const claims = await oidc.exchange({
      code: 'code', codeVerifier: 'v', redirectUri: 'https://app.example/cb', nonce: 'n',
    })
    expect(claims).toMatchObject({ subject: 'subject-1', email: 'user@example.com' })
  })

  it('omits the client secret entirely for a public client', async () => {
    const transport: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/.well-known/openid-configuration') {
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
        })
      }
      return Response.json({})
    }
    const publicClient = new OidcClient({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      scopes: ['openid'],
      requestTimeoutMs: 1000,
      fetch: transport,
    })
    await expect(publicClient.exchange({
      code: 'code', codeVerifier: 'v', redirectUri: 'https://app.example/cb', nonce: 'n',
    })).rejects.toThrow(/neither an ID token/u)
  })

  it('generates distinct unguessable tokens', () => {
    const first = randomToken()
    expect(first).not.toBe(randomToken())
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u)
  })
})
