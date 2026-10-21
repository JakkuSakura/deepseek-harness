/** Email, domain, and subject whitelist for provider identities. */

import type { OidcClaims } from './oidc.ts'

/** Normalized allowlist; every set is lowercase, so matching is case-insensitive. */
export interface IdentityWhitelist {
  /** Exact email addresses. */
  readonly emails: ReadonlySet<string>
  /** Exact email domains, without a leading `@`. */
  readonly domains: ReadonlySet<string>
  /** Exact provider subject identifiers. */
  readonly subjects: ReadonlySet<string>
}

/**
 * Normalize configured allowlist entries.
 * @param entries - email addresses, domains, and subject identifiers.
 * @returns a case-insensitive allowlist.
 */
export function identityWhitelist(entries: {
  readonly emails: readonly string[]
  readonly domains: readonly string[]
  readonly subjects: readonly string[]
}): IdentityWhitelist {
  const normalized = (values: readonly string[]): string[] =>
    values.map(value => value.trim()).filter(value => value !== '')
  return {
    emails: new Set(normalized(entries.emails).map(value => value.toLowerCase())),
    domains: new Set(normalized(entries.domains).map(value => value.replace(/^@/u, '').toLowerCase())),
    subjects: new Set(normalized(entries.subjects)),
  }
}

/**
 * Whether the allowlist names at least one identity.
 * @param whitelist - normalized allowlist.
 * @returns true when any email, domain, or subject is present.
 */
export function hasWhitelistEntry(whitelist: IdentityWhitelist): boolean {
  return whitelist.emails.size > 0 || whitelist.domains.size > 0 || whitelist.subjects.size > 0
}

/**
 * Decide whether one verified identity is allowed to use this host.
 * An email marked unverified never authorizes; a subject entry authorizes
 * independently of email.
 * @param whitelist - normalized allowlist.
 * @param claims - verified provider claims.
 * @returns true when an email, email domain, or subject matches.
 */
export function identityAllowed(whitelist: IdentityWhitelist, claims: OidcClaims): boolean {
  if (whitelist.subjects.has(claims.subject)) return true
  if (claims.email === undefined || claims.emailVerified === false) return false
  const email = claims.email.trim().toLowerCase()
  if (whitelist.emails.has(email)) return true
  const at = email.lastIndexOf('@')
  return at > 0 && whitelist.domains.has(email.slice(at + 1))
}
