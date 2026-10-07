/**
 * Watching the composer for input the reader has not sent.
 *
 * DSH keeps a draft per Session inside the composer's own model, which is why a draft
 * survives switching Sessions. That model is not a service — it is created and disposed
 * with the composer — so a plugin cannot read another Session's draft from its context.
 *
 * The composer itself is readable, so this watches it. What it cannot know is *which*
 * Session the composer belongs to; the caller supplies that, because the sidebar already
 * tracks the active Session. The resulting memory is the page's rather than the Session's,
 * so a **reload forgets it**: the draft is still in the composer, the dot is not, until
 * the reader types in it again. That is the price of reading the only surface available,
 * and it is stated rather than hidden.
 *
 * @module dsh-plugin-git-tree/client/draftwatch
 */

/**
 * The composer, in either of the shapes DSH renders it: a textarea, or the rich
 * contenteditable host. Matched in that order so a textarea wins when both exist.
 */
export const COMPOSER = 'textarea, [contenteditable="true"]'

/** The slice of a composer this needs. */
export interface ComposerElement {
  readonly value?: unknown
  readonly textContent?: string | null
}

/** The slice of a document this needs. */
export interface DraftWatchTarget {
  querySelector(selector: string): unknown
  addEventListener?(type: string, listener: () => void): void
  removeEventListener?(type: string, listener: () => void): void
}

/** The slice of a MutationObserver this needs. */
export interface ComposerObserver {
  observe(target: object, options: MutationObserverInit): void
  disconnect(): void
}

/**
 * What a composer holds, as text.
 *
 * A textarea keeps it in `value`; a contenteditable host keeps it in `textContent`. An
 * empty composer is `''`, never null, so callers can compare without guarding.
 * @param element - the composer, or null when the page has none.
 * @returns the text it holds.
 */
export function composerText(element: unknown): string {
  if (typeof element !== 'object' || element === null) return ''
  const { value, textContent } = element as ComposerElement
  if (typeof value === 'string') return value
  if (typeof textContent === 'string') return textContent
  return ''
}

/**
 * Watch the composer and report what it holds.
 *
 * The text is reported on every change, including the change to empty that sending causes,
 * so the caller's memory follows the composer rather than accumulating. Reporting happens
 * for the composer it found when it started; if DSH replaces that element, the caller
 * reinstalls, which the sidebar does on every render.
 * @param target - the document to read and listen to.
 * @param onText - called with the composer's current text, per change.
 * @param createObserver - how to observe; injected so this can be driven in a test.
 * @returns a disposer that stops listening and disconnects the observer.
 */
export function installDraftWatch(
  target: DraftWatchTarget,
  onText: (text: string) => void,
  createObserver: (callback: () => void) => ComposerObserver = callback => new MutationObserver(callback),
): () => void {
  const element = target.querySelector(COMPOSER)
  const report = (): void => { onText(composerText(element)) }
  // An async composer mutation lands in textContent without an input event, so both are
  // watched. `report` is idempotent, so the overlap costs a repeated string compare.
  const onInput = (): void => { report() }
  target.addEventListener?.('input', onInput)
  let observer: ComposerObserver | null = null
  if (typeof element === 'object' && element !== null) {
    observer = createObserver(report)
    observer.observe(element, { childList: true, subtree: true, characterData: true })
  }
  report()
  return () => {
    target.removeEventListener?.('input', onInput)
    observer?.disconnect()
  }
}
