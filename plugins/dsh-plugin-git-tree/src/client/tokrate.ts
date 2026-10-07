/**
 * A rolling output-token rate for one Session.
 *
 * The figure DSH shows is `decodeTokens / decodeMs` from a whole-log projection, so
 * it is the Session's lifetime decode average: it converges and then stops moving.
 * Its window cannot be made honest either, because the durable log carries one
 * `assistant/message` per **step** — the tokens are not in the log at all.
 *
 * So the rate is measured here instead, from the one thing that does move: the
 * cumulative output-token count, sampled on a clock. That is what makes the decay
 * work. Two samples of a counter say nothing about speed; two samples *and the time
 * between them* do. Sampling on a timer even when nothing changed is the whole
 * trick — the counter stops growing while the wall clock does not, so the window
 * fills with stillness and the rate falls. When the last step's growth ages past the
 * window, the rate is zero, which is what a Session that has stopped is doing.
 *
 * Wall-clock seconds, not decode seconds: decode time also stops growing when the
 * Session idles, so a ratio over it would hold its last value forever — the very
 * freeze this exists to avoid. Time spent in tools therefore counts against the
 * rate, which is the honest reading of "how fast right now".
 */

/** One observation of a Session's cumulative output tokens. */
export interface TokenSample {
  /** When the observation was taken, in epoch milliseconds. */
  readonly at: number
  /** The cumulative token count then, which only ever rises within one turn. */
  readonly tokens: number
  /**
   * The cumulative bytes streamed then, from the transcript the browser already has.
   *
   * Tokens arrive only when a step *finishes*, because that is when the provider
   * reports usage — so mid-step the token rate is stale or silent, while characters
   * are arriving the whole time. Bytes are the fallback that keeps the figure honest
   * during the only part anyone watches.
   */
  readonly bytes?: number
}

/** How far back the rate looks. */
export const TOK_RATE_WINDOW_MS = 15_000

/** What the window currently says. */
export interface TokenRate {
  /** Tokens per second across the window; null until two samples span real time. */
  readonly perSecond: number | null
  /** The samples the rate was taken from, newest last. */
  readonly samples: readonly TokenSample[]
}

/** The rate before anything has been observed. */
export const NO_TOKEN_RATE: TokenRate = { perSecond: null, samples: [] }

/**
 * Fold one observation in and say what the window holds.
 * @param held - the samples kept so far.
 * @param at - when this observation was taken, in epoch milliseconds.
 * @param tokens - the cumulative output-token count, or null when the Session reports none.
 * @param windowMs - how far back to look.
 * @returns the pruned samples and the rate they give.
 */
export function observeTokens(
  held: readonly TokenSample[],
  at: number,
  tokens: number | null,
  windowMs: number = TOK_RATE_WINDOW_MS,
): TokenRate {
  // An unreadable count carries the last one forward rather than recording
  // nothing: the Session is still idle, and a window that kept no samples would
  // read as "cannot say" instead of falling to zero with everything else.
  const carried = tokens !== null && Number.isFinite(tokens) && tokens >= 0
    ? tokens
    : held[held.length - 1]?.tokens ?? null
  if (carried === null) {
    return { perSecond: rateOf(prune(held, at, windowMs)), samples: prune(held, at, windowMs) }
  }
  const tokensSeen = carried
  const newest = held[held.length - 1]
  // A counter that went backwards is a different run — a new turn, or a Session
  // that was replaced — so the old growth is not this Session's to average.
  const kept = newest !== undefined && tokensSeen < newest.tokens ? [] : held
  const last = kept[kept.length - 1]
  // One sample per instant: a re-render inside the same millisecond is the same
  // observation, not a second one.
  const appended = last !== undefined && last.at === at
    ? [...kept.slice(0, -1), { at, tokens: tokensSeen }]
    : [...kept, { at, tokens: tokensSeen }]
  const samples = prune(appended, at, windowMs)
  return { perSecond: rateOf(samples), samples }
}

/** Keep only what falls inside the window ending at `at`. */
function prune(samples: readonly TokenSample[], at: number, windowMs: number): readonly TokenSample[] {
  // Strictly what is inside the window. Nothing is kept as an anchor: after a gap
  // longer than the window the honest answer is that nothing is known, and the next
  // observation starts the measurement fresh rather than measuring across the gap.
  const floor = at - windowMs
  return samples.filter(sample => sample.at >= floor)
}

/** Tokens per second across the samples, or null when they cannot say. */
function rateOf(samples: readonly TokenSample[]): number | null {
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (first === undefined || last === undefined) return null
  const seconds = (last.at - first.at) / 1000
  if (seconds <= 0) return null
  return Math.max(0, (last.tokens - first.tokens) / seconds)
}
