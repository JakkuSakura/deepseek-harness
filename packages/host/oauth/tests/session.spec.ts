/** Signed session cookies: minting, authority binding, expiry, and malformed input. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAuthSessionStore, readCookie } from '../src/session.ts'
import { TestCredentials } from './credentials.ts'

function secretOf(credentials: TestCredentials): string {
  const record = credentials.records.get('host-oauth/session')
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw new Error('test credential store has no grant record')
  }
  const secret = (record.payload as Record<string, unknown>)['secret']
  if (typeof secret !== 'string') throw new Error('test credential record has no secret')
  return secret
}

function create(store = new TestCredentials(), maxAgeDays = 30): Promise<OAuthSessionStore> {
  return OAuthSessionStore.create(store.asProvider(), { cookieName: 'dsh-oauth', maxAgeDays })
}

afterEach(() => { vi.useRealTimers() })

describe('OAuthSessionStore', () => {
  it('mints one authority-bound cookie and verifies it through the Cookie header', async () => {
    const store = await create()
    const minted = store.mint('app.example', { subject: 's1', email: 'user@example.com', name: 'User' }, true)
    expect(minted.pair).toMatch(/^dsh-oauth-[A-Za-z0-9_-]{22}=v1\./)
    expect(minted.header).toContain('Secure')
    expect(minted.expiresAt).toBeGreaterThan(Date.now())

    expect(store.verify('app.example', minted.pair.split('=')[1] as string)).toEqual({
      subject: 's1', email: 'user@example.com', name: 'User',
    })
    expect(store.read('app.example', minted.pair)).toMatchObject({ subject: 's1' })
    expect(store.read('other.example', minted.pair)).toBeUndefined()
    expect(store.read('app.example', undefined)).toBeUndefined()
    expect(store.read('app.example', 'unrelated=1')).toBeUndefined()
    expect(store.cookieNameFor('app.example')).not.toBe(store.cookieNameFor('other.example'))
  })

  it('mints a cookie for an identity without email or name', async () => {
    const store = await create()
    const minted = store.mint('app.example', { subject: 's1' }, false)
    expect(minted.header).not.toContain('Secure')
    expect(store.verify('app.example', minted.pair.split('=')[1] as string)).toEqual({ subject: 's1' })
  })

  it('rejects tampered, malformed, foreign-authority, and stale values', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-20T00:00:00.000Z'))
    const credentials = new TestCredentials()
    const store = await create(credentials)
    const minted = store.mint('app.example', { subject: 's1' }, false)
    const value = minted.pair.split('=')[1] as string
    const [version, body, signature] = value.split('.') as [string, string, string]

    expect(store.verify('app.example', 'broken')).toBeUndefined()
    expect(store.verify('app.example', `v2.${body}.${signature}`)).toBeUndefined()
    expect(store.verify('app.example', `v1.${body}`)).toBeUndefined()
    expect(store.verify('app.example', `v1.${body}.`)).toBeUndefined()
    expect(store.verify('app.example', `v1.${body}.%%%`)).toBeUndefined()
    expect(store.verify('app.example', `v1.${body}.${signature.slice(0, -1)}x`)).toBeUndefined()
    expect(store.verify('app.example', `v1.${body}.${signature}.extra`)).toBeUndefined()

    // A signature that is valid base64url but not canonical decodes to a
    // different string, and an undecodable body never reaches JSON parsing.
    expect(store.verify('app.example', `v1.${body}.AB`)).toBeUndefined()
    const { createHmac } = await import('node:crypto')
    const secret = secretOf(credentials)
    const invalidBody = '%%%'
    const invalidSignature = createHmac('sha256', Buffer.from(secret, 'base64url'))
      .update(invalidBody).digest('base64url')
    expect(store.verify('app.example', `v1.${invalidBody}.${invalidSignature}`)).toBeUndefined()

    const forged = Buffer.from(JSON.stringify({
      version: 1,
      authority: 'app.example',
      subject: 'attacker',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 1000,
    })).toString('base64url')
    expect(store.verify('app.example', `v1.${forged}.${signature}`)).toBeUndefined()
    expect(store.verify('app.example', `v1.%%%.${signature}`)).toBeUndefined()

    expect(store.verify('other.example', value)).toBeUndefined()

    vi.setSystemTime(new Date('2026-11-21T00:00:00.000Z'))
    expect(store.verify('app.example', value)).toBeUndefined()
    expect(version).toBe('v1')
  })

  it('rejects signed payloads with unsupported fields', async () => {
    const credentials = new TestCredentials()
    const store = await create(credentials)
    const secret = secretOf(credentials)
    const payloads = [
      'not json',
      { version: 2, authority: 'a' },
      { version: 1, authority: 1, subject: 's', issuedAt: 0, expiresAt: 1 },
      { version: 1, authority: 'a', subject: 1, issuedAt: 0, expiresAt: 1 },
      { version: 1, authority: 'a', subject: 's', email: 1, issuedAt: 0, expiresAt: 1 },
      { version: 1, authority: 'a', subject: 's', name: 1, issuedAt: 0, expiresAt: 1 },
      { version: 1, authority: 'a', subject: 's', issuedAt: 'now', expiresAt: 1 },
      { version: 1, authority: 'a', subject: 's', issuedAt: 0, expiresAt: 'later' },
    ]
    const { createHmac } = await import('node:crypto')
    for (const payload of payloads) {
      const body = typeof payload === 'string'
        ? Buffer.from(payload).toString('base64url')
        : Buffer.from(JSON.stringify(payload)).toString('base64url')
      const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('base64url')
      expect(store.verify('a', `v1.${body}.${signature}`)).toBeUndefined()
    }
  })

  it('loads one secret per activation, replaces a deleted one, and fails loud on an invalid record', async () => {
    const credentials = new TestCredentials()
    const store = await create(credentials)
    const first = store.mint('app.example', { subject: 's1' }, false)
    expect(credentials.records.size).toBe(1)

    credentials.records.clear()
    expect(store.verify('app.example', first.pair.split('=')[1] as string)).toMatchObject({ subject: 's1' })

    const reactivated = await create(credentials)
    expect(reactivated.verify('app.example', first.pair.split('=')[1] as string)).toBeUndefined()

    const unsupported = new TestCredentials()
    unsupported.records.set('host-oauth/session', { kind: 'api-key', key: 'nope' })
    await expect(create(unsupported)).rejects.toThrow(/unsupported format/u)

    const invalid = new TestCredentials()
    invalid.records.set('host-oauth/session', { kind: 'grant', payload: { version: 1, secret: 'short' } })
    await expect(create(invalid)).rejects.toThrow(/invalid secret/u)

    const nonString = new TestCredentials()
    nonString.records.set('host-oauth/session', { kind: 'grant', payload: { version: 1, secret: 42 } })
    await expect(create(nonString)).rejects.toThrow(/invalid secret/u)

    const discarded = new TestCredentials()
    discarded.discarded = true
    await expect(create(discarded)).rejects.toThrow(/was not created/u)

    await expect(create(new TestCredentials(), Number.MAX_SAFE_INTEGER)).rejects.toThrow(/safe timestamp range/u)
  })
})

describe('readCookie', () => {
  it('reads an exact cookie and ignores lookalikes', () => {
    expect(readCookie('a=1; dsh=ok; b=2', 'dsh')).toBe('ok')
    expect(readCookie('a=1; dshx=no', 'dsh')).toBeUndefined()
    expect(readCookie('without-value', 'dsh')).toBeUndefined()
  })
})
