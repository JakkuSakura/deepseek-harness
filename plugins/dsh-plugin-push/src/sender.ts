/**
 * Sending one notification, and reading what the push service said about it.
 *
 * The transport is injected rather than imported so the rules here can be tested
 * against a stub. What matters is the classification: a push service says `404` or
 * `410` when a subscription is gone for good, and everything else — including a
 * rate limit or a bad minute — must *not* unsubscribe someone.
 *
 * @module dsh-plugin-push/sender
 */
import { type PushMessage, type StoredSubscription, shouldPrune } from './push.ts'

/** What became of one delivery attempt. */
export type PushOutcome = 'sent' | 'prune' | 'failed'

/** Sends the payload to the push service. Throws with a `statusCode` on rejection. */
export type PushTransport = (subscription: StoredSubscription, payload: string) => Promise<void>

/**
 * Deliver one message to one subscription.
 * @param transport - the network call.
 * @param subscription - where to send it.
 * @param message - what to send.
 * @returns what the caller should do about the subscription.
 */
export async function deliver(
  transport: PushTransport,
  subscription: StoredSubscription,
  message: PushMessage,
): Promise<PushOutcome> {
  try {
    await transport(subscription, JSON.stringify(message))
    return 'sent'
  } catch (error: unknown) {
    const statusCode = (error as { statusCode?: unknown } | null)?.statusCode
    if (typeof statusCode === 'number' && shouldPrune(statusCode)) return 'prune'
    return 'failed'
  }
}
