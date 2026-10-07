/**
 * The live speed of a stream, as a speedometer rather than an average.
 *
 * There is no window here, deliberately. A window answers "how fast has this been
 * going" and lags by its own width — which is exactly what makes a rate feel wrong
 * while you are watching it. This answers "how fast is it going now", from the gap
 * between the last two observations, smoothed by an exponential decay so it does not
 * twitch on a single slow chunk.
 *
 * The reason it measures **bytes** is worth stating: a provider reports token usage
 * when a step *ends*, and never during one. So through the whole of a generation —
 * the only part anyone watches — there are no tokens to count, and the text arriving
 * is the only evidence there is. Tokens are the better number when they exist; this
 * is the one that exists when the number people want is happening.
 *
 * @module dsh-plugin-git-tree/liverate
 */

/** How long a spike takes to fade, in milliseconds. Not a window: a decay. */
export const DECAY_MS = 1200

/** The live view of a stream. */
export interface LiveRate {
  /** Cumulative bytes seen, for the running count. */
  readonly bytes: number
  /** Bytes per second, right now, or null before there is a second observation. */
  readonly perSecond: number | null
  /** When the last observation was taken. */
  readonly at: number
  /** When bytes last actually arrived, which is what "stalled" is measured from. */
  readonly movedAt: number
}

/** Nothing observed yet. */
export const IDLE_RATE: LiveRate = { bytes: 0, perSecond: null, at: 0, movedAt: 0 }

/**
 * Deadband under which a stream counts as stopped.
 *
 * Without it a decay never actually reaches zero, so an idle figure would crawl
 * towards it forever and never look idle.
 */
const STALLED_MS = 1500

/**
 * Fold one observation of cumulative bytes into the live rate.
 *
 * A counter that went backwards is a new stream — a new turn, or a Session that was
 * replaced — and starts again rather than reading the reset as negative speed.
 * @param held - the rate so far.
 * @param at - now, in epoch milliseconds.
 * @param bytes - cumulative bytes streamed.
 * @param decayMs - the decay constant.
 * @returns the updated rate.
 */
export function observeBytes(
  held: LiveRate,
  at: number,
  bytes: number,
  decayMs: number = DECAY_MS,
): LiveRate {
  if (!Number.isFinite(bytes) || bytes < 0) return held
  // A counter that went backwards is a new stream: a new turn, or a Session that was
  // replaced. It starts again rather than reading the reset as negative speed.
  if (bytes < held.bytes) return { bytes, perSecond: null, at, movedAt: at }
  const moved = bytes - held.bytes
  const elapsed = at - held.at
  if (held.at === 0 || elapsed <= 0) return { bytes, perSecond: held.perSecond, at, movedAt: held.movedAt }

  if (moved === 0) {
    // Bytes stopped arriving. Long enough and the stream is over, so the figure reads
    // zero rather than crawling towards it forever; before that it decays, so a pause
    // between chunks is visible as a slowdown rather than a cliff.
    const sinceMove = at - held.movedAt
    if (sinceMove >= STALLED_MS) return { bytes, perSecond: 0, at, movedAt: held.movedAt }
    if (held.perSecond === null) return { ...held, at }
    const weight = 1 - Math.exp(-elapsed / decayMs)
    const perSecond = held.perSecond * (1 - weight)
    return { bytes, perSecond: perSecond < 1 ? 0 : perSecond, at, movedAt: held.movedAt }
  }

  const instant = (moved / elapsed) * 1000
  if (held.perSecond === null) return { bytes, perSecond: instant, at, movedAt: at }
  // Exponential decay towards the new reading: responsive to a change, unmoved by a
  // single outlier.
  const weight = 1 - Math.exp(-elapsed / decayMs)
  const perSecond = held.perSecond + (instant - held.perSecond) * weight
  return { bytes, perSecond: perSecond < 1 ? 0 : perSecond, at, movedAt: at }
}

/**
 * The figure to show, and its unit.
 *
 * Tokens when the provider has reported them, bytes otherwise — never both, because
 * two numbers in one slot is how a readout becomes unreadable.
 * @param rate - the live rate.
 * @returns the text, or null when there is nothing honest to say.
 */
export function rateLabel(rate: LiveRate): string | null {
  // Bytes only. A token figure was carried here first and dropped, because the only
  // count DSH exposes is cumulative and includes cache reads: one step measured 458
  // output tokens and 594,458 total, of which 593,792 were cache. A number that large
  // and that wrong is worse than no number, and the live figure is the honest one
  // anyway — it is what is actually arriving.
  const live = rate.perSecond
  if (live === null || live <= 0) return null
  if (live < 1024) return `${String(Math.round(live))} B/s`
  if (live < 1024 * 1024) return `${(live / 1024).toFixed(1)} kB/s`
  return `${(live / (1024 * 1024)).toFixed(1)} MB/s`
}
