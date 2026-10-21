/** Identity whitelist matching and cookie serialization. */

import { describe, expect, it } from 'vitest'
import { serializeCookie } from '../src/session.ts'
import { hasWhitelistEntry, identityAllowed, identityWhitelist } from '../src/whitelist.ts'

const whitelist = identityWhitelist({
  emails: [' Person@Example.COM ', ''],
  domains: ['@Corp.Example', ''],
  subjects: [' subject-1 ', ''],
})

describe('identity whitelist', () => {
  it('normalizes addresses, domains, and subjects', () => {
    expect(hasWhitelistEntry(whitelist)).toBe(true)
    expect([...whitelist.emails]).toEqual(['person@example.com'])
    expect([...whitelist.domains]).toEqual(['corp.example'])
    expect([...whitelist.subjects]).toEqual(['subject-1'])
  })

  it('reports an empty allowlist', () => {
    expect(hasWhitelistEntry(identityWhitelist({ emails: [' '], domains: [], subjects: [] }))).toBe(false)
  })

  it('matches an exact email case-insensitively', () => {
    expect(identityAllowed(whitelist, { subject: 's', email: 'PERSON@example.com' })).toBe(true)
  })

  it('matches a domain exactly, not a suffix or a lookalike', () => {
    expect(identityAllowed(whitelist, { subject: 's', email: 'person@corp.example' })).toBe(true)
    expect(identityAllowed(whitelist, { subject: 's', email: 'person@sub.corp.example' })).toBe(false)
    expect(identityAllowed(whitelist, { subject: 's', email: 'person@notcorp.example' })).toBe(false)
    expect(identityAllowed(whitelist, { subject: 's', email: 'person@corp.example.evil' })).toBe(false)
  })

  it('matches a subject independently of email', () => {
    expect(identityAllowed(whitelist, { subject: 'subject-1' })).toBe(true)
    expect(identityAllowed(whitelist, { subject: 'subject-2' })).toBe(false)
  })

  it('refuses an unverified or malformed email', () => {
    expect(identityAllowed(whitelist, {
      subject: 's', email: 'person@example.com', emailVerified: false,
    })).toBe(false)
    expect(identityAllowed(whitelist, { subject: 's', email: 'no-at-sign' })).toBe(false)
    expect(identityAllowed(whitelist, { subject: 's', email: '@example.com' })).toBe(false)
  })
})

describe('serializeCookie', () => {
  it('emits lifetime, path, and Lax flags', () => {
    const value = serializeCookie('session', 'abc', 60, false)
    expect(value).toMatch(/^session=abc; Max-Age=60; Path=\/; Expires=.*; HttpOnly; SameSite=Lax$/u)
    expect(value).not.toContain('Secure')
  })

  it('marks an HTTPS origin Secure and clears with an epoch expiry', () => {
    const secure = serializeCookie('session', 'abc', 60, true)
    expect(secure).toContain('; Secure')
    const cleared = serializeCookie('session', '', 0, true, '/auth')
    expect(cleared).toMatch(/^session=; Max-Age=0; Path=\/auth; Expires=Thu, 01 Jan 1970/u)
  })
})
