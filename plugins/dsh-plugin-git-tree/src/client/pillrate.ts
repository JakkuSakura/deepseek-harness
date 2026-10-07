/**
 * Overwrite DSH's own `tok/s` pill with the rolling rate.
 *
 * This is a hack, and deliberately so. The honest fix is inside the pill's own
 * component, and it cannot be reached from a plugin:
 *
 * - The figure reads a **whole-log** projection, so it is the Session's lifetime
 *   decode average.
 * - The window cannot be finished off host-side either: the projection seam takes a
 *   definition and owns delivery, so a unit cannot re-publish on a clock — and a
 *   decaying number *needs* a clock, because the count stops while time does not.
 * - The component has no clock of its own, so even a correct value would sit frozen
 *   on screen until something else made it re-render.
 *
 * So the number is written into the DOM instead, and kept there. React re-renders
 * the pill constantly while a Session streams, which would normally undo an
 * override; a MutationObserver re-applies it on the next frame, so the reader sees
 * one number rather than a flicker between two.
 *
 * Prefer the other ways of showing this, which do not reach into anyone's DOM: the
 * panel's own status bar shows the same rate.
 */

import { IDLE_RATE, type LiveRate, observeBytes, rateLabel } from './liverate.ts'

/** What DSH renders for the figure: a formatted number then the unit. */
const RATE_TEXT = /^\s*[\d.,]+\s*(?:tok\/s|[kMB]?B\/s)\s*$/

/**
 * Where a rate figure belongs to a *message* rather than to the composer.
 *
 * The pill and a turn's own usage panel are built from the same copy, so both read
 * `N tok/s`. The turn's is a historical figure for that turn and must keep it; only
 * the composer's ambient pill is the live one.
 */
const IN_A_MESSAGE = '[data-chat-flow], [data-chat-flow-key]'

/**
 * Bytes currently rendered in the transcript.
 *
 * The cheapest honest live signal there is. A provider reports token usage when a
 * step *ends* and never during one, so for the whole of a generation the text being
 * rendered is the only evidence of speed — and the browser already has it, without
 * asking any service for anything.
 * @returns the character count of every transcript row.
 */
function renderedBytes(): number {
  if (typeof document === 'undefined') return 0
  let total = 0
  for (const node of document.querySelectorAll('[data-chat-flow]')) {
    total += node.textContent?.length ?? 0
  }
  return total
}

/** The live stream rate, carried between observations so each knows the last. */
let live: LiveRate = IDLE_RATE

/**
 * The live stream rate, for whoever draws it.
 *
 * The pill and the panel must show one measurement, not two. The sampler lives here
 * because this is what observes the DOM per chunk, and the panel asks rather than
 * keeping a second clock — which is exactly how the two came to disagree before.
 * @returns the rate as it stands.
 */
export function liveRateSnapshot(): LiveRate {
  return live
}

/** How often the live figure is refreshed, in milliseconds. */
const LIVE_TICK_MS = 250

/**
 * Whether a piece of text is DSH's rate figure.
 * @param text - the node's text.
 * @returns true when it is a rate and nothing else.
 */
export function isRateText(text: string): boolean {
  return RATE_TEXT.test(text)
}

/**
 * The text this hack would put in the pill.
 * @param perSecond - tokens per second, or null when there is nothing to say.
 * @returns the replacement text, or null to leave the pill alone.
 */
export function rateText(): string | null {
  return rateLabel(live)
}

/**
 * Keep the pill showing the rolling rate.
 *
 * Rewrites in place rather than adding a second figure, and re-applies after any
 * mutation so React cannot win the race. The observer is scoped to the composer's
 * own area, so a rate shown anywhere else — a turn-usage popover, say — is left
 * alone.
 * @param root - the subtree to watch; the document is the fallback.
 * @returns a function that stops the override and puts the DOM back.
 */
export function installRateOverride(root?: ParentNode): () => void {
  if (typeof document === 'undefined') return () => {}
  const scope: ParentNode = root ?? document.body
  /** The nodes this hack has already written, so they can be restored. */
  const written = new Map<Element, string>()

  const apply = (): void => {
    const text = rateText()
    if (text === null) return
    const walker = document.createTreeWalker(scope as Node, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement
      if (parent === null || !isRateText(node.nodeValue ?? '')) continue
      if (parent.closest(IN_A_MESSAGE) !== null) continue
      if (!written.has(parent)) written.set(parent, node.nodeValue ?? '')
      if (node.nodeValue !== text) node.nodeValue = text
    }
  }

  const sample = (): void => {
    live = observeBytes(live, Date.now(), renderedBytes())
  }

  const observer = new MutationObserver(() => {
    // Sampled per mutation, which is per chunk: the point of this figure is that it
    // is instantaneous rather than averaged over a window.
    sample()
    apply()
  })
  observer.observe(scope as Node, { childList: true, subtree: true, characterData: true })
  // And a clock, because the count stops while time does not: a stalled stream
  // mutates nothing, so without this the number would sit frozen at its last value.
  const ticker = setInterval(() => {
    sample()
    apply()
  }, LIVE_TICK_MS)
  // A Node timer holds the process open; a browser has no such notion. Unref where it
  // exists, so loading this plugin in a test runner cannot hang the runner.
  ;(ticker as unknown as { unref?: () => void }).unref?.()
  sample()
  apply()

  return () => {
    observer.disconnect()
    clearInterval(ticker)
    for (const [element, original] of written) {
      const node = element.firstChild
      if (node !== null) node.nodeValue = original
    }
    written.clear()
  }
}
