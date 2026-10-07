/**
 * Turning Session events into notifications.
 *
 * The Host observes sessions through the projection seam, and a projection is a
 * **fold over the whole log** — it is replayed when the process starts and can be
 * rewound. So deciding here, purely, has a second purpose beyond testability: the
 * caller can be a fold without the fold's replay history turning into a burst of
 * notifications about turns that finished last week.
 *
 * @module dsh-plugin-push/trigger
 */
import type { PushNotice } from './push.ts'

/** One event, as the projection seam delivers it. */
export interface SessionEventLike {
  readonly type: string
  /** Wall-clock milliseconds, as the log recorded it. */
  readonly time?: number
  readonly data?: Record<string, unknown>
}

/**
 * How recent an event must be to be worth announcing.
 *
 * The guard that makes a replayed fold safe: a turn that ended days ago is part of
 * the history being folded, not news.
 */
export const RECENT_MS = 120_000

/** Field names a turn's failure might arrive under, read in order. */
const FAILURE_KEYS = ['error', 'failure', 'failed', 'aborted'] as const

/**
 * Whether an event says its turn failed.
 *
 * Read defensively and across several names, because the log's failure shape is not
 * specified here: a false negative announces "finished" when something broke, which
 * is far better than a false positive shouting "failed" at a healthy turn.
 * @param event - the event to read.
 * @returns true when it carries a failure.
 */
export function isFailure(event: SessionEventLike): boolean {
  const data = event.data
  if (data === undefined) return false
  for (const key of FAILURE_KEYS) {
    const value = data[key]
    if (value === true) return true
    if (typeof value === 'string' && value !== '' && value !== 'ok' && value !== 'success') return true
    if (typeof value === 'object' && value !== null) return true
  }
  const status = data['status']
  return status === 'error' || status === 'failed' || status === 'aborted'
}

/**
 * The notification an event deserves, if any.
 *
 * Only `turn/end` announces. A failed *tool call* is part of working — agents retry
 * — and announcing those would make the notifier noise, which is how a notifier gets
 * switched off. The turn is the unit someone actually waits for.
 * @param event - the event to judge.
 * @param sessionId - the session it belongs to.
 * @param now - the current time, injected so this stays pure.
 * @param recentMs - how recent an event must be to count.
 * @returns the notice, or null when nothing should be said.
 */
export function noticeForEvent(
  event: SessionEventLike,
  sessionId: string,
  now: number,
  recentMs: number = RECENT_MS,
): PushNotice | null {
  if (event.type !== 'turn/end') return null
  if (typeof event.time !== 'number' || !Number.isFinite(event.time)) return null
  if (now - event.time > recentMs) return null
  return {
    trigger: isFailure(event) ? 'error' : 'finished',
    sessionId,
  }
}

/**
 * A key identifying one notification, for suppressing repeats.
 *
 * The recency guard already excludes history; this covers the narrower case of a
 * fold driven twice over the same recent event, which a rewind can do.
 * @param notice - the notice.
 * @param event - the event that produced it.
 * @returns a key stable across replays of the same event.
 */
export function noticeKey(notice: PushNotice, event: SessionEventLike): string {
  const time = typeof event.time === 'number' ? String(event.time) : '?'
  return `${notice.sessionId}:${notice.trigger}:${time}`
}
