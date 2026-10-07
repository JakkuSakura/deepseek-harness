/**
 * The pure half of Web Push: what a notification says, which one an event deserves,
 * and how a push service's answer is read.
 *
 * A notification is a small document with a short life, so everything here is a
 * function of its input — no clock, no session, no network — and every rule can be
 * tested without a browser, a push service or a key pair.
 *
 * @module dsh-plugin-push/push
 */

/** The three things worth interrupting someone for. */
export type PushTrigger = 'needs-input' | 'finished' | 'error'

/** What a notification needs to know, however the trigger was observed. */
export interface PushNotice {
  readonly trigger: PushTrigger
  /** The Session this is about, used as the notification's tag. */
  readonly sessionId: string
  /** A human title for the Session, when one is known. */
  readonly title?: string
  /** One line of detail: what it is waiting for, or what went wrong. */
  readonly detail?: string
  /** Where a click should land. */
  readonly url?: string
}

/** The wire form handed to the service worker's `showNotification`. */
export interface PushMessage {
  readonly title: string
  readonly body: string
  /** Collapses repeat notifications for one Session instead of stacking them. */
  readonly tag: string
  readonly renotify: boolean
  readonly data: { readonly url?: string; readonly sessionId: string }
}

/** The titles, which are the only part that differs by trigger. */
const HEADLINES: Record<PushTrigger, string> = {
  'needs-input': 'DeepSeek Harness needs you',
  finished: 'DeepSeek Harness finished',
  error: 'DeepSeek Harness failed',
}

/**
 * The notification for a notice.
 *
 * The tag is the Session, so a Session that interrupts twice replaces its own
 * notification rather than accumulating a stack — the thing that makes people turn
 * notifications off.
 * @param notice - what happened.
 * @returns the message for the service worker.
 */
export function notificationFor(notice: PushNotice): PushMessage {
  const subject = notice.title !== undefined && notice.title.trim() !== '' ? notice.title.trim() : notice.sessionId
  const detail = notice.detail !== undefined && notice.detail.trim() !== '' ? notice.detail.trim() : undefined
  return {
    title: HEADLINES[notice.trigger],
    body: detail === undefined ? subject : `${subject} — ${detail}`,
    tag: notice.sessionId,
    renotify: true,
    data: {
      ...(notice.url === undefined ? {} : { url: notice.url }),
      sessionId: notice.sessionId,
    },
  }
}

/**
 * Whether a push service's status means the subscription is gone for good.
 *
 * `404` and `410` are the two answers that mean "never send this again"; everything
 * else — including `429` and `5xx` — is temporary, and pruning on those would
 * silently unsubscribe someone because a push service had a bad minute.
 * @param statusCode - the response status.
 * @returns true when the subscription should be dropped.
 */
export function shouldPrune(statusCode: number): boolean {
  return statusCode === 404 || statusCode === 410
}

/** The subset of a browser `PushSubscription` this plugin keeps. */
export interface StoredSubscription {
  readonly endpoint: string
  readonly keys: { readonly p256dh: string; readonly auth: string }
}

/**
 * Read a subscription as the browser sent it.
 *
 * Validated rather than trusted: this arrives over HTTP, and a malformed record
 * stored now is a crash inside the push library later, where the error will be far
 * less obvious than a rejected request here.
 * @param value - the parsed request body.
 * @returns the subscription, or null when it is not one.
 */
export function readSubscription(value: unknown): StoredSubscription | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const endpoint = record['endpoint']
  const keys = record['keys']
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) return null
  if (typeof keys !== 'object' || keys === null) return null
  const { p256dh, auth } = keys as Record<string, unknown>
  if (typeof p256dh !== 'string' || p256dh === '') return null
  if (typeof auth !== 'string' || auth === '') return null
  return { endpoint, keys: { p256dh, auth } }
}

/**
 * The default `path` written into the service worker's push subscription options.
 *
 * Exported because the client half, the worker and the host all have to agree on
 * it, and a mismatch is a 403 from the push service rather than an obvious failure.
 * @param value - a string from configuration.
 * @returns the value, or undefined when unusable.
 */
export function normalizeSubject(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.startsWith('mailto:') || trimmed.startsWith('https://') ? trimmed : undefined
}

/**
 * Decode the URL-safe base64 a VAPID public key is written in.
 *
 * `pushManager.subscribe` takes bytes, not the string the server stores, and the
 * alphabet differs from ordinary base64 — which is the whole reason this is here
 * rather than a one-liner at the call site.
 * @param value - the base64url string.
 * @returns the bytes.
 */
export function bytesFromUrlBase64(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  // Constructed over an explicit ArrayBuffer: `pushManager` takes an ArrayBuffer
  // view, and a bare `new Uint8Array(n)` is typed as possibly shared.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
