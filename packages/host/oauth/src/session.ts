/** Signed, authority-bound browser session cookie and cookie serialization for the OAuth gate. */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'

const SECRET_RECORD_KEY = credentialKey('host-oauth', 'session')
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const SECRET_BYTES = 32
const COOKIE_PAYLOAD_VERSION = 1
const STORED_SECRET_VERSION = 1
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/

interface StoredSecretPayload {
  readonly version: typeof STORED_SECRET_VERSION
  readonly secret: string
}

interface SessionCookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION
  readonly authority: string
  readonly subject: string
  readonly email?: string
  readonly name?: string
  readonly issuedAt: number
  readonly expiresAt: number
}

/** Identity established by one successful authorization-code exchange. */
export interface SessionIdentity {
  /** Provider subject identifier. */
  readonly subject: string
  /** Provider email claim, when the provider released one. */
  readonly email?: string
  /** Provider display name, when the provider released one. */
  readonly name?: string
}

/** One minted browser cookie: header value and the facts a caller needs to log it out. */
export interface SessionCookie {
  /** Generated `name=value` pair. */
  readonly pair: string
  /** Full `Set-Cookie` value carrying lifetime and flags. */
  readonly header: string
  /** Absolute expiry in epoch milliseconds. */
  readonly expiresAt: number
}

/** Options for one session cookie authority scope. */
export interface SessionStoreOptions {
  /** Base cookie name; the request authority is appended as a hash. */
  readonly cookieName: string
  /** Absolute session lifetime in days. */
  readonly maxAgeDays: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

function canonicalSecret(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined
  const decoded = decodeBase64Url(value)
  return decoded !== undefined && decoded.byteLength === SECRET_BYTES ? decoded : undefined
}

function storedSecret(record: CredentialRecord | undefined): Buffer | undefined {
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || !isRecord(record.payload)
    || record.payload.version !== STORED_SECRET_VERSION) {
    throw new Error('host-oauth: session credential record has an unsupported format')
  }
  const secret = canonicalSecret(record.payload.secret)
  if (secret === undefined) throw new Error('host-oauth: session credential record has an invalid secret')
  return secret
}

async function initializeSecret(credentials: CredentialProvider): Promise<Buffer> {
  const generated: StoredSecretPayload = {
    version: STORED_SECRET_VERSION,
    secret: encodeBase64Url(randomBytes(SECRET_BYTES)),
  }
  const record = await credentials.modifyRecord(SECRET_RECORD_KEY, (current) => {
    if (current !== undefined) {
      storedSecret(current)
      return Promise.resolve(undefined)
    }
    return Promise.resolve({ kind: 'grant', payload: generated })
  })
  const secret = storedSecret(record)
  if (secret === undefined) throw new Error('host-oauth: session credential record was not created')
  return secret
}

function signature(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

function encodeSession(payload: SessionCookiePayload, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v1.${body}.${encodeBase64Url(signature(secret, body))}`
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function decodeSession(value: string, secret: Buffer): SessionCookiePayload | undefined {
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || version !== 'v1' || body === undefined || encodedSignature === undefined) {
    return undefined
  }
  const actual = decodeBase64Url(encodedSignature)
  if (actual === undefined) return undefined
  const expected = signature(secret, body)
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return undefined
  let decoded: unknown
  try {
    const bodyBytes = decodeBase64Url(body)
    if (bodyBytes === undefined) return undefined
    decoded = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(decoded)
    || decoded.version !== COOKIE_PAYLOAD_VERSION
    || typeof decoded.authority !== 'string'
    || typeof decoded.subject !== 'string'
    || (decoded.email !== undefined && typeof decoded.email !== 'string')
    || (decoded.name !== undefined && typeof decoded.name !== 'string')) {
    return undefined
  }
  const issuedAt = safeInteger(decoded.issuedAt)
  const expiresAt = safeInteger(decoded.expiresAt)
  if (issuedAt === undefined || expiresAt === undefined) return undefined
  return {
    version: COOKIE_PAYLOAD_VERSION,
    authority: decoded.authority,
    subject: decoded.subject,
    ...decoded.email === undefined ? {} : { email: decoded.email },
    ...decoded.name === undefined ? {} : { name: decoded.name },
    issuedAt,
    expiresAt,
  }
}

/**
 * Read one exact cookie value without implementing general Cookie decoding.
 * @param headerValue - raw Cookie request header.
 * @param name - exact cookie name to find.
 * @returns the value, or undefined when the header does not carry that name.
 */
export function readCookie(headerValue: string, name: string): string | undefined {
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/**
 * Serialize one cookie with the OAuth gate's fixed attributes.
 * @param name - cookie name.
 * @param value - already validated cookie-safe value.
 * @param maxAgeSeconds - remaining lifetime; zero clears the cookie.
 * @param secure - whether the browser-facing origin is HTTPS.
 * @param path - cookie path scope.
 * @returns a `Set-Cookie` header value.
 */
export function serializeCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
  path = '/',
): string {
  const expires = new Date(maxAgeSeconds === 0 ? 0 : Date.now() + maxAgeSeconds * 1000).toUTCString()
  return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=${path}; Expires=${expires}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

/**
 * Mints and verifies authority-bound browser session cookies. Verification is
 * synchronous so Connection can authenticate ordinary requests; the signing
 * secret is loaded once from the credential provider at activation.
 */
export class OAuthSessionStore {
  private constructor(
    private readonly secret: Buffer,
    private readonly cookieName: string,
    private readonly maxAgeMilliseconds: number,
  ) {}

  /**
   * Initialize the store and create its durable signing secret when this
   * Harness home has none.
   * @param credentials - persistent credential provider for the Web profile.
   * @param options - cookie name and absolute lifetime.
   * @returns initialized store.
   */
  static async create(credentials: CredentialProvider, options: SessionStoreOptions): Promise<OAuthSessionStore> {
    const maxAgeMilliseconds = options.maxAgeDays * DAY_MILLISECONDS
    if (!Number.isSafeInteger(maxAgeMilliseconds) || !Number.isSafeInteger(Date.now() + maxAgeMilliseconds)) {
      throw new Error('host-oauth: sessionMaxAgeDays exceeds the safe timestamp range')
    }
    return new OAuthSessionStore(await initializeSecret(credentials), options.cookieName, maxAgeMilliseconds)
  }

  /**
   * Cookie name for one canonical request authority.
   * @param authority - canonical host and port.
   * @returns the authority-bound cookie name.
   */
  cookieNameFor(authority: string): string {
    const digest = createHash('sha256').update(authority).digest()
    return `${this.cookieName}-${encodeBase64Url(digest).slice(0, 22)}`
  }

  /**
   * Mint one authority-bound session cookie.
   * @param authority - canonical request authority the browser uses.
   * @param identity - authenticated subject, email, and display name.
   * @param secure - whether the browser-facing origin is HTTPS.
   * @returns cookie pair, full header, and absolute expiry.
   */
  mint(authority: string, identity: SessionIdentity, secure: boolean): SessionCookie {
    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.maxAgeMilliseconds
    const payload: SessionCookiePayload = {
      version: COOKIE_PAYLOAD_VERSION,
      authority,
      subject: identity.subject,
      ...identity.email === undefined ? {} : { email: identity.email },
      ...identity.name === undefined ? {} : { name: identity.name },
      issuedAt,
      expiresAt,
    }
    const name = this.cookieNameFor(authority)
    const value = encodeSession(payload, this.secret)
    return {
      pair: `${name}=${value}`,
      header: serializeCookie(name, value, Math.floor(this.maxAgeMilliseconds / 1000), secure),
      expiresAt,
    }
  }

  /**
   * Verify one cookie value for this authority.
   * @param authority - canonical request authority.
   * @param value - cookie value from the request.
   * @returns the established identity, or undefined for a forged, stale, or foreign cookie.
   */
  verify(authority: string, value: string): SessionIdentity | undefined {
    const payload = decodeSession(value, this.secret)
    if (payload === undefined || payload.authority !== authority) return undefined
    const now = Date.now()
    if (payload.issuedAt > now || payload.expiresAt <= now
      || payload.expiresAt <= payload.issuedAt
      || payload.expiresAt - payload.issuedAt > this.maxAgeMilliseconds) {
      return undefined
    }
    return {
      subject: payload.subject,
      ...payload.email === undefined ? {} : { email: payload.email },
      ...payload.name === undefined ? {} : { name: payload.name },
    }
  }

  /**
   * Read and verify the session from one request's Cookie header.
   * @param authority - canonical request authority.
   * @param cookieHeader - raw Cookie header, or undefined.
   * @returns the established identity, or undefined when absent or invalid.
   */
  read(authority: string, cookieHeader: string | undefined): SessionIdentity | undefined {
    if (cookieHeader === undefined) return undefined
    const value = readCookie(cookieHeader, this.cookieNameFor(authority))
    return value === undefined ? undefined : this.verify(authority, value)
  }

  /**
   * Clear the session cookie header for one authority.
   * @param authority - canonical host and port.
   * @param secure - whether the browser-facing origin is HTTPS.
   * @returns a `Set-Cookie` value with zero lifetime.
   */
  clear(authority: string, secure: boolean): string {
    return serializeCookie(this.cookieNameFor(authority), '', 0, secure)
  }
}
