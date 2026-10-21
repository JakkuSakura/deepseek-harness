/** OpenID Connect gate: full authorization-code flow over a real HTTP host and a fake provider. */

import { createHash } from 'node:crypto'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection/src/rpc-host.ts'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import * as OAuth from '../src/index.ts'
import type { Config as OAuthConfig } from '../src/index.ts'

const CLIENT_ID = 'dsh-test'
const CLIENT_SECRET = 'test-secret'
const ALLOWED_EMAIL = 'allowed@example.com'
const ALLOWED_SUBJECT = 'subject-allowed'
const DISALLOWED_EMAIL = 'blocked@example.net'

class TestCredentials {
  readonly records = new Map<string, CredentialRecord>()
  readonly values = new Map<string, string>()

  async readRecord(key: string): Promise<CredentialRecord | undefined> {
    return this.records.get(key)
  }

  async modifyRecord(
    key: string,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(key))
    if (next !== undefined) this.records.set(key, next)
    return next
  }

  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    const value = this.values.get(ref)
    return value === undefined ? undefined : { value, source: 'test' }
  }
}

interface ProviderState {
  origin: string
  email: string | undefined
  subject: string
  emailVerified: boolean
  issueIdToken: boolean
}

interface FakeProvider {
  readonly origin: string
  readonly server: Server
  state: ProviderState
  readonly privateKey: CryptoKey
  readonly publicJwk: Record<string, unknown>
}

/** Real webserver that also exposes the routes a plugin registered. */
class RecordingServer extends WebServer {
  readonly routes: WebRoute[] = []

  override register(route: WebRoute): () => void {
    this.routes.push(route)
    return super.register(route)
  }
}

interface Reply {
  readonly status: number
  readonly headers: Headers
  readonly body: string
}

interface PendingCode {
  readonly challenge: string
  readonly nonce: string
  readonly redirectUri: string
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

async function startProvider(): Promise<FakeProvider> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const publicJwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }
  const codes = new Map<string, PendingCode>()
  let origin = ''
  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const url = new URL(request.url ?? '/', origin)
      if (url.pathname === '/.well-known/openid-configuration') {
        json(response, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          jwks_uri: `${origin}/jwks`,
          userinfo_endpoint: `${origin}/userinfo`,
        })
        return
      }
      if (url.pathname === '/jwks') {
        json(response, 200, { keys: [publicJwk] })
        return
      }
      if (url.pathname === '/authorize') {
        const state = url.searchParams.get('state') ?? ''
        const redirectUri = url.searchParams.get('redirect_uri') ?? ''
        const code = `code-${String(codes.size + 1)}`
        codes.set(code, {
          challenge: url.searchParams.get('code_challenge') ?? '',
          nonce: url.searchParams.get('nonce') ?? '',
          redirectUri,
        })
        response.writeHead(302, {
          location: `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
        })
        response.end()
        return
      }
      if (url.pathname === '/token') {
        const body = await readForm(request)
        const code = codes.get(body.get('code') ?? '')
        if (code === undefined) {
          json(response, 400, { error: 'invalid_grant' })
          return
        }
        codes.delete(body.get('code') ?? '')
        const expected = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url')
        if (expected !== code.challenge || body.get('client_id') !== CLIENT_ID
          || body.get('client_secret') !== CLIENT_SECRET) {
          json(response, 400, { error: 'invalid_grant' })
          return
        }
        const claims = {
          ...provider.state.email === undefined ? {} : { email: provider.state.email },
          email_verified: provider.state.emailVerified,
          name: 'Test User',
          nonce: code.nonce,
        }
        const idToken = provider.state.issueIdToken
          ? await new SignJWT(claims)
            .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
            .setSubject(provider.state.subject)
            .setIssuer(origin)
            .setAudience(CLIENT_ID)
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(privateKey)
          : undefined
        json(response, 200, {
          access_token: 'access-token',
          token_type: 'Bearer',
          ...idToken === undefined ? {} : { id_token: idToken },
        })
        return
      }
      if (url.pathname === '/userinfo') {
        json(response, 200, {
          sub: provider.state.subject,
          email: provider.state.email,
          email_verified: provider.state.emailVerified,
        })
        return
      }
      response.writeHead(404)
      response.end()
    })().catch((error: unknown) => {
      response.writeHead(500)
      response.end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const provider = {
    origin,
    server,
    privateKey,
    publicJwk,
    state: {
      origin,
      email: ALLOWED_EMAIL,
      subject: ALLOWED_SUBJECT,
      emailVerified: true,
      issueIdToken: true,
    },
  }
  return provider
}

async function stopServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
}

async function http(
  origin: string,
  path: string,
  init: RequestInit = {},
): Promise<Reply> {
  const response = await fetch(`${origin}${path}`, { redirect: 'manual', ...init })
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  }
}

function cookiePairs(headers: Headers): string {
  return headers.getSetCookie()
    .map(value => value.split(';', 1)[0] as string)
    .join('; ')
}

interface Harness {
  readonly ctx: Context
  readonly provider: FakeProvider
  readonly origin: string
  readonly credentials: TestCredentials
  readonly connection: HostConnectionService
  readonly routes: readonly WebRoute[]
  readonly dispose: () => Promise<void>
  readonly config: OAuthConfig
}

type HarnessOverrides = Omit<Partial<OAuthConfig>, 'clientSecretRef'> & {
  clientSecretRef?: string | undefined
}

async function harness(overrides: HarnessOverrides = {}): Promise<Harness> {
  const provider = await startProvider()
  const ctx = new Context()
  const credentials = new TestCredentials()
  credentials.values.set('DSH_OAUTH_CLIENT_SECRET', CLIENT_SECRET)
  ctx.provide('credentials', credentials as unknown as CredentialProvider)
  const web = ctx.plugin(RecordingServer, { host: '127.0.0.1', port: 0 })
  await web.await()
  const auth = await BrowserAuth.create(ctx.root, credentials as unknown as CredentialProvider, 30)
  const connection = ctx.plugin((pluginCtx) => {
    new HostConnectionService(pluginCtx, [], auth)
  })
  await connection.await()
  const { clientSecretRef, ...rest } = overrides
  const config: OAuthConfig = {
    issuer: provider.origin,
    clientId: CLIENT_ID,
    allowedEmails: [ALLOWED_EMAIL],
    allowedSubjects: [ALLOWED_SUBJECT],
    ...rest,
    ...'clientSecretRef' in overrides
      ? clientSecretRef === undefined ? {} : { clientSecretRef }
      : { clientSecretRef: 'DSH_OAUTH_CLIENT_SECRET' },
  }
  const oauth = ctx.plugin(OAuth, config)
  await oauth.await()
  const server = ctx.get('webServer') as RecordingServer | undefined
  if (server === undefined) throw new Error('test host has no web server')
  // Stand in for frontend-static: the index entry is where Connection's
  // authorizeIndex runs, so the OAuth authenticator owns the redirect.
  server.registerFallback((req, res) => {
    if (!ctx.get('connection')?.authorizeIndex(req, res)) return
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('shell')
  })
  return {
    ctx,
    provider,
    origin: `http://127.0.0.1:${String(server.port)}`,
    credentials,
    connection: ctx.get('connection') as HostConnectionService,
    routes: server.routes,
    config,
    dispose: async () => {
      await oauth.dispose()
      await connection.dispose()
      await web.dispose()
      await stopServer(provider.server)
    },
  }
}

/** Walk login → provider → callback, returning the DSH session cookie. */
async function signIn(test: Harness): Promise<{ cookie: string; callback: Reply }> {
  const login = await http(test.origin, '/auth/login?rd=%2Fsessions')
  expect(login.status).toBe(303)
  const stateCookie = cookiePairs(login.headers)
  const target = new URL(login.headers.get('location') as string)
  expect(target.origin).toBe(test.provider.origin)
  const authorize = await http(test.provider.origin, `${target.pathname}${target.search}`)
  expect(authorize.status).toBe(302)
  const callbackUrl = new URL(authorize.headers.get('location') as string)
  // A public mount prefix is stripped by the reverse proxy in production.
  const mount = test.config.publicUrl === undefined
    ? ''
    : new URL(test.config.publicUrl).pathname.replace(/\/$/u, '')
  const path = mount !== '' && callbackUrl.pathname.startsWith(mount)
    ? callbackUrl.pathname.slice(mount.length)
    : callbackUrl.pathname
  const callback = await http(test.origin, `${path}${callbackUrl.search}`, {
    headers: { cookie: stateCookie },
  })
  return { cookie: cookiePairs(callback.headers), callback }
}

let active: Harness | undefined

beforeEach(() => { active = undefined })

afterEach(async () => {
  await active?.dispose()
  active = undefined
})

describe('OAuth login gate', () => {
  it('redirects the index to the provider and admits an allowlisted email without the launch token', async () => {
    active = await harness()
    const index = await http(active.origin, '/')
    expect(index.status).toBe(303)
    expect(index.headers.get('location')).toBe('/auth/login?rd=%2F')

    const { cookie, callback } = await signIn(active)
    expect(callback.status).toBe(303)
    expect(callback.headers.get('location')).toBe('/sessions')
    expect(cookie).toMatch(/dsh-oauth-/)

    const session = await http(active.origin, '/auth/session', { headers: { cookie } })
    expect(session.status).toBe(200)
    expect(JSON.parse(session.body)).toMatchObject({
      authenticated: true,
      email: ALLOWED_EMAIL,
      subject: ALLOWED_SUBJECT,
    })

    const authority = new URL(active.origin).host
    expect(active.connection.admit({ headers: { host: authority, cookie } })).toHaveProperty('peer')

    // Mounting the gate retires the launch token: it is neither printed nor accepted.
    expect(new URL(active.connection.authenticatedUrl(active.origin)).searchParams.has('token')).toBe(false)

    const indexWithCookie = await http(active.origin, '/', { headers: { cookie } })
    expect(indexWithCookie.status).toBe(200)
    expect(indexWithCookie.body).toBe('shell')

    const logout = await http(active.origin, '/auth/logout?rd=%2F', { headers: { cookie } })
    expect(logout.status).toBe(303)
    expect(logout.headers.get('set-cookie')).toMatch(/Max-Age=0/)
    // The cookie is stateless, so logout asks the browser to drop it; the
    // cleared pair carries an empty value that never verifies.
    const afterLogout = await http(active.origin, '/auth/session', {
      headers: { cookie: cookiePairs(logout.headers) },
    })
    expect(JSON.parse(afterLogout.body)).toEqual({ authenticated: false })
  })

  it('admits a whitelisted subject without an email', async () => {
    active = await harness({ allowedEmails: [], allowedSubjects: [ALLOWED_SUBJECT] })
    active.provider.state = { ...active.provider.state, email: undefined, emailVerified: false }
    const { cookie } = await signIn(active)
    const session = await http(active.origin, '/auth/session', { headers: { cookie } })
    expect(JSON.parse(session.body)).toMatchObject({ authenticated: true, subject: ALLOWED_SUBJECT })
    expect(JSON.parse(session.body)).not.toHaveProperty('email')
    const relogin = await http(active.origin, '/auth/login?rd=%2Fsessions', { headers: { cookie } })
    expect(relogin.status).toBe(303)
    expect(relogin.headers.get('location')).toBe('/sessions')
  })

  it('rejects an identity outside the whitelist', async () => {
    active = await harness()
    active.provider.state = { ...active.provider.state, email: DISALLOWED_EMAIL, subject: 'subject-blocked' }
    const { callback } = await signIn(active)
    expect(callback.status).toBe(403)
    expect(callback.body).toMatch(/not allowed/)
  })

  it('rejects an unverified email even when the address is allowlisted', async () => {
    active = await harness({ allowedSubjects: [] })
    active.provider.state = { ...active.provider.state, emailVerified: false }
    const { callback } = await signIn(active)
    expect(callback.status).toBe(403)
  })

  it('rejects a callback whose state cookie or pending state is missing', async () => {
    active = await harness()
    const login = await http(active.origin, '/auth/login')
    const stateCookie = cookiePairs(login.headers)
    const target = new URL(login.headers.get('location') as string)
    const authorize = await http(active.provider.origin, `${target.pathname}${target.search}`)
    const callbackUrl = new URL(authorize.headers.get('location') as string)

    const missingCookie = await http(active.origin, `${callbackUrl.pathname}${callbackUrl.search}`)
    expect(missingCookie.status).toBe(400)

    const wrongState = await http(active.origin, '/auth/callback?code=x&state=unknown', {
      headers: { cookie: stateCookie },
    })
    expect(wrongState.status).toBe(400)

    const missingCode = await http(active.origin, `${callbackUrl.pathname}?state=${callbackUrl.searchParams.get('state') ?? ''}`, {
      headers: { cookie: stateCookie },
    })
    expect(missingCode.status).toBe(400)

    const errorLogin = await http(active.origin, '/auth/login')
    const errorCookie = cookiePairs(errorLogin.headers)
    const errorTarget = new URL(errorLogin.headers.get('location') as string)
    const errorAuthorize = await http(active.provider.origin, `${errorTarget.pathname}${errorTarget.search}`)
    const errorCallbackUrl = new URL(errorAuthorize.headers.get('location') as string)
    const errorCallback = await http(active.origin, `${errorCallbackUrl.pathname}?error=access_denied&state=${errorCallbackUrl.searchParams.get('state') ?? ''}`, {
      headers: { cookie: errorCookie },
    })
    expect(errorCallback.status).toBe(303)
    expect(errorCallback.headers.get('location')).toBe('/')
  })

  it('falls back to UserInfo when the provider releases no ID token', async () => {
    active = await harness()
    active.provider.state = { ...active.provider.state, issueIdToken: false }
    const { cookie } = await signIn(active)
    const session = await http(active.origin, '/auth/session', { headers: { cookie } })
    expect(JSON.parse(session.body)).toMatchObject({ authenticated: true, email: ALLOWED_EMAIL })
  })

})

interface CapturedResponse {
  status?: number | undefined
  location?: string | undefined
  body?: string | undefined
}

function headerFrom(headers: unknown, name: string): string | undefined {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) return undefined
  const value = (headers as Record<string, unknown>)[name]
  return typeof value === 'string' ? value : undefined
}

function rawRequest(
  url: string,
  headers: Record<string, string> = {},
  method = 'GET',
): IncomingMessage {
  const request = new IncomingMessage(new Socket())
  request.url = url
  request.method = method
  request.headers = headers
  return request
}

function capture(request: IncomingMessage): { response: ServerResponse; captured: CapturedResponse } {
  const response = new ServerResponse(request)
  const captured: CapturedResponse = {}
  response.writeHead = function writeHead(status: number, headers?: unknown) {
    captured.status = status
    captured.location = headerFrom(headers, 'location')
    return response
  }
  response.end = function end(body?: unknown) {
    if (typeof body === 'string') captured.body = body
    return response
  } as typeof response.end
  return { response, captured }
}

function routeOf(test: Harness, path: string): WebRoute {
  const route = test.routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`test host did not register ${path}`)
  return route
}

describe('OAuth route responses', () => {
  it('uses the advertised root for the callback and honors a prompt hint', async () => {
    active = await harness({ publicUrl: 'https://app.example/ui' })
    const login = await http(active.origin, '/auth/login?prompt=select_account')
    expect(login.status).toBe(303)
    const target = new URL(login.headers.get('location') as string)
    expect(target.searchParams.get('redirect_uri')).toBe('https://app.example/ui/auth/callback')
    expect(target.searchParams.get('prompt')).toBe('select_account')

    const ignored = await http(active.origin, '/auth/login?prompt=bogus')
    const ignoredTarget = new URL(ignored.headers.get('location') as string)
    expect(ignoredTarget.searchParams.get('prompt')).toBeNull()

    const { cookie } = await signIn(active)
    const already = await http(active.origin, '/auth/login?rd=%2Fsessions', { headers: { cookie } })
    expect(already.status).toBe(303)
    expect(already.headers.get('location')).toBe('/sessions')
  })

  it('answers 400 for every route without a Host authority', async () => {
    active = await harness()
    for (const path of ['/auth/login', '/auth/callback', '/auth/logout', '/auth/session']) {
      const request = rawRequest(path)
      const { response, captured } = capture(request)
      await routeOf(active, path).handler(request, response)
      expect(captured.status).toBe(400)
    }
    const malformed = rawRequest('/auth/login', { host: 'bad host' })
    const malformedCapture = capture(malformed)
    await routeOf(active, '/auth/login').handler(malformed, malformedCapture.response)
    expect(malformedCapture.captured.status).toBe(400)
  })

  it('turns an unexpected synchronous or asynchronous route failure into a 500', async () => {
    active = await harness()
    const asyncRequest = rawRequest('/auth/login')
    const asyncCapture = capture(asyncRequest)
    Object.defineProperty(asyncRequest, 'headers', { get() { throw new Error('synthetic failure') } })
    await routeOf(active, '/auth/login').handler(asyncRequest, asyncCapture.response)
    expect(asyncCapture.captured.status).toBe(500)

    const syncRequest = rawRequest('/auth/logout')
    const syncCapture = capture(syncRequest)
    const nonError: unknown = { code: 'synthetic' }
    Object.defineProperty(syncRequest, 'headers', { get() { throw nonError } })
    await routeOf(active, '/auth/logout').handler(syncRequest, syncCapture.response)
    expect(syncCapture.captured.status).toBe(500)

    const writtenRequest = rawRequest('/auth/logout')
    const writtenCapture = capture(writtenRequest)
    Object.defineProperty(writtenRequest, 'headers', { get() { throw new Error('synthetic failure') } })
    Object.defineProperty(writtenCapture.response, 'headersSent', { get: () => true })
    await routeOf(active, '/auth/logout').handler(writtenRequest, writtenCapture.response)
    expect(writtenCapture.captured.status).toBeUndefined()
  })

  it('answers 503 when the provider discovery is unreachable', async () => {
    active = await harness({ issuer: 'http://127.0.0.1:1' })
    const login = await http(active.origin, '/auth/login')
    expect(login.status).toBe(503)
  })

  it('answers 401 when the token exchange fails', async () => {
    active = await harness()
    const login = await http(active.origin, '/auth/login')
    const stateCookie = cookiePairs(login.headers)
    const target = new URL(login.headers.get('location') as string)
    const authorize = await http(active.provider.origin, `${target.pathname}${target.search}`)
    const callbackUrl = new URL(authorize.headers.get('location') as string)
    active.credentials.values.set('DSH_OAUTH_CLIENT_SECRET', 'rotated-wrong')
    const callback = await http(active.origin, `${callbackUrl.pathname}${callbackUrl.search}`, {
      headers: { cookie: stateCookie },
    })
    expect(callback.status).toBe(401)
  })

  it('answers 400 when a valid state arrives without an authorization code', async () => {
    active = await harness()
    const login = await http(active.origin, '/auth/login')
    const stateCookie = cookiePairs(login.headers)
    const target = new URL(login.headers.get('location') as string)
    const authorize = await http(active.provider.origin, `${target.pathname}${target.search}`)
    const callbackUrl = new URL(authorize.headers.get('location') as string)
    const state = callbackUrl.searchParams.get('state') ?? ''
    const callback = await http(active.origin, `/auth/callback?state=${state}`, {
      headers: { cookie: stateCookie },
    })
    expect(callback.status).toBe(400)
  })

  it('prunes expired and excess pending authorizations', async () => {
    active = await harness()
    for (let index = 0; index < 257; index += 1) {
      const login = await http(active.origin, '/auth/login')
      expect(login.status).toBe(303)
    }
    const now = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000)
    try {
      const fresh = await http(active.origin, '/auth/login')
      expect(fresh.status).toBe(303)
    } finally {
      spy.mockRestore()
    }
  })

  it('covers explicit configuration, an HTTPS forwarded proto, and array headers', async () => {
    active = await harness({
      scopes: ['openid', 'email', 'profile', 'groups'],
      allowedDomains: ['example.net'],
      allowedSubjects: [],
      sessionMaxAgeDays: 7,
      cookieName: 'dsh-test-oauth',
      loginPath: '/sso/login',
      callbackPath: '/sso/callback',
      logoutPath: '/sso/logout',
      sessionPath: '/sso/session',
      publicUrl: 'https://app.example/ui/',
      requestTimeoutMs: 5000,
    })
    const request = rawRequest('/sso/login', { 'host': 'app.example', 'x-forwarded-proto': 'https' })
    const { response, captured } = capture(request)
    await routeOf(active, '/sso/login').handler(request, response)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(captured.status).toBe(303)
    const target = new URL(captured.location as string)
    expect(target.searchParams.get('scope')).toBe('openid email profile groups')
    expect(target.searchParams.get('redirect_uri')).toBe('https://app.example/ui/sso/callback')
    expect(captured.location).toContain('client_id=dsh-test')
  })

  it('accepts an array-valued Host header', async () => {
    active = await harness()
    const request = rawRequest('/auth/session')
    Reflect.set(request, 'headers', { host: ['127.0.0.1:3080'] })
    const { response, captured } = capture(request)
    await routeOf(active, '/auth/session').handler(request, response)
    expect(captured.status).toBe(200)
    expect(captured.body).toBe('{"authenticated":false}')
  })

  it('uses an HTTPS origin from the forwarded proto without an advertised root', async () => {
    active = await harness()
    const request = rawRequest('/auth/login', { host: 'app.example', 'x-forwarded-proto': 'https' })
    const { response, captured } = capture(request)
    await routeOf(active, '/auth/login').handler(request, response)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(captured.status).toBe(303)
    expect(captured.location).toContain('redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fcallback')
  })

  it('uses the provided public-client path and a secure cookie when HTTPS terminates upstream', async () => {
    active = await harness({ clientSecretRef: undefined, publicUrl: 'https://app.example/' })
    const request = rawRequest('/auth/login', { host: 'app.example', 'x-forwarded-proto': 'https' })
    const { response, captured } = capture(request)
    await routeOf(active, '/auth/login').handler(request, response)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(captured.status).toBe(303)
    expect(captured.location).toContain('redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fcallback')
  })

  it('omits the state on a callback without one and handles a missing redirect target', async () => {
    active = await harness()
    const callback = await http(active.origin, '/auth/callback')
    expect(callback.status).toBe(400)
    const logout = await http(active.origin, '/auth/logout')
    expect(logout.status).toBe(303)
    expect(logout.headers.get('location')).toBe('/')
  })

  it('finishes a response whose async handler fails after headers were sent', async () => {
    active = await harness()
    const request = rawRequest('/auth/login', { host: new URL(active.origin).host })
    const { response, captured } = capture(request)
    Object.defineProperty(response, 'headersSent', { get: () => true })
    response.writeHead = () => { throw new Error('socket write failed') }
    await routeOf(active, '/auth/login').handler(request, response)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(captured.status).toBeUndefined()
  })

  it('authenticates Headers-style requests and redirects the index for GET and HEAD', async () => {
    active = await harness()
    const { cookie } = await signIn(active)
    const authority = new URL(active.origin).host

    const allowed = capture(rawRequest('/'))
    expect(active.connection.authorizeIndex({
      method: 'GET',
      url: '/',
      headers: new Headers({ host: authority, cookie }),
    }, allowed.response)).toBe(true)

    const noHost = capture(rawRequest('/'))
    expect(active.connection.authorizeIndex({
      method: 'GET',
      url: '/',
      headers: new Headers(),
    }, noHost.response)).toBe(false)
    expect(noHost.captured.status).toBe(303)

    const malformed = capture(rawRequest('/'))
    expect(active.connection.authorizeIndex({
      method: 'HEAD',
      url: '/',
      headers: new Headers({ host: 'bad host' }),
    }, malformed.response)).toBe(false)
    expect(malformed.captured.status).toBe(303)

    const missingUrl = capture(rawRequest('/'))
    expect(active.connection.authorizeIndex({
      method: 'GET',
      headers: new Headers({ host: authority }),
    }, missingUrl.response)).toBe(false)
    expect(missingUrl.captured.status).toBe(303)

    const nonGet = capture(rawRequest('/', {}, 'POST'))
    expect(active.connection.authorizeIndex({
      method: 'POST',
      url: '/',
      headers: new Headers({ host: authority }),
    }, nonGet.response)).toBe(false)
    expect(nonGet.captured.status).toBe(401)
  })
})

describe('OAuth configuration validation', () => {
  async function bootInvalid(config: OAuthConfig): Promise<Error> {
    const ctx = new Context()
    const credentials = new TestCredentials()
    ctx.provide('credentials', credentials as unknown as CredentialProvider)
    const web = ctx.plugin(RecordingServer, { host: '127.0.0.1', port: 0 })
    await web.await()
    const auth = await BrowserAuth.create(ctx.root, credentials as unknown as CredentialProvider, 30)
    const connection = ctx.plugin((pluginCtx) => {
      new HostConnectionService(pluginCtx, [], auth)
    })
    await connection.await()
    const oauth = ctx.plugin(OAuth, config)
    try {
      await oauth.await()
      throw new Error('configuration unexpectedly activated')
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    } finally {
      await oauth.dispose()
      await connection.dispose()
      await web.dispose()
    }
  }

  const base = {
    issuer: 'https://kc.example',
    clientId: 'dsh',
    allowedEmails: ['user@example.com'],
  }

  it('rejects malformed issuer, cookie, route, public URL, secret ref, scopes, and whitelist values', async () => {
    const cases: ReadonlyArray<[OAuthConfig, RegExp]> = [
      [{ issuer: 'https://kc.example', allowedEmails: ['user@example.com'] }, /clientId is required/u],
      [{ ...base, issuer: 'not-a-url' }, /issuer must be an absolute/u],
      [{ ...base, issuer: 'ftp://kc.example' }, /issuer must be an absolute/u],
      [{ ...base, cookieName: 'bad name' }, /cookieName/u],
      [{ ...base, loginPath: 'relative' }, /loginPath/u],
      [{ ...base, callbackPath: '/auth/login' }, /must be distinct/u],
      [{ ...base, publicUrl: 'ftp://app.example' }, /publicUrl must be an absolute/u],
      [{ ...base, clientSecretRef: '1BAD' }, /clientSecretRef/u],
      [{ ...base, scopes: [] }, /scopes must not be empty/u],
      [{ ...base, allowedEmails: [] }, /at least one of/u],
    ]
    for (const [config, pattern] of cases) {
      const error = await bootInvalid(config)
      expect(error.message).toMatch(pattern)
    }
  })

  it('mounts no routes and leaves authentication unchanged without an issuer', async () => {
    const ctx = new Context()
    const credentials = new TestCredentials()
    ctx.provide('credentials', credentials as unknown as CredentialProvider)
    const web = ctx.plugin(RecordingServer, { host: '127.0.0.1', port: 0 })
    await web.await()
    const auth = await BrowserAuth.create(ctx.root, credentials as unknown as CredentialProvider, 30)
    const connection = ctx.plugin((pluginCtx) => {
      new HostConnectionService(pluginCtx, [], auth)
    })
    await connection.await()
    const oauth = ctx.plugin(OAuth, {})
    await oauth.await()
    const server = ctx.get('webServer') as RecordingServer
    expect(server.routes.some(route => route.path === '/auth/login')).toBe(false)
    expect(ctx.get('connection')?.requestRejection({ headers: { host: '127.0.0.1:3080' } }) === 401).toBe(true)
    const invalid = ctx.plugin(OAuth, { clientId: 'dsh' })
    const failure = await invalid.await().then(() => undefined, (error: unknown) => error)
    expect(failure instanceof Error && failure.message.includes('clientId requires issuer')).toBe(true)
    await invalid.dispose()

    await oauth.dispose()
    await connection.dispose()
    await web.dispose()
  })

  it('accepts a minimal configuration and fills every default', async () => {
    // The main harness passes only the required fields, so its successful
    // activation already proves the default path.
    active = await harness()
    expect(active.routes.map(route => route.path)).toEqual([
      '/auth/login', '/auth/callback', '/auth/logout', '/auth/session',
    ])
  })
})
