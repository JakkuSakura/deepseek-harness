/**
 * Which Sessions have input the reader has not sent.
 *
 * DSH keeps a draft per Session inside the composer's own model — which is why a draft
 * survives switching Sessions, and why marking it is worth doing. That model is not a
 * service: it is created and disposed with the composer, so a plugin cannot read another
 * Session's draft from its context.
 *
 * What the plugin *can* see is the composer itself, so this keeps the bookkeeping: the
 * reader types in the composer for the Session that is open, and the Session they typed
 * in is remembered as having a draft until that composer is emptied. The memory is the
 * page's, not the Session's, so a **reload forgets it** — the draft is still there, the
 * dot is not, until the reader types in it again. That limitation is the price of
 * reading the only surface available, and it is stated rather than hidden.
 *
 * @module dsh-plugin-git-tree/client/drafts
 */

/** The Sessions that currently hold unsent input, and the last text seen for each. */
export type DraftMemory = ReadonlyMap<string, string>

/** Nothing typed anywhere. */
export const NO_DRAFTS: DraftMemory = new Map()

/**
 * Record what a Session's composer holds.
 *
 * Empty text forgets the Session rather than remembering an empty draft, so a sent or
 * cleared prompt takes its dot with it.
 * @param held - the memory so far.
 * @param sessionId - the Session whose composer changed.
 * @param text - what the composer holds now.
 * @returns the next memory.
 */
export function rememberDraft(held: DraftMemory, sessionId: string, text: string): DraftMemory {
  const next = new Map(held)
  if (text.trim() === '') next.delete(sessionId)
  else next.set(sessionId, text)
  return next
}

/**
 * Whether a Session is holding unsent input.
 * @param held - the memory.
 * @param sessionId - the Session to ask about.
 * @returns true when it has a draft.
 */
export function hasDraft(held: DraftMemory, sessionId: string): boolean {
  return held.has(sessionId)
}

/**
 * Whether a composer's text is still a draft.
 *
 * Attachments count: a Session holding only a queued file is still waiting on the
 * reader, even with an empty box.
 * @param text - the composer's text.
 * @param attachments - how many files are staged in it.
 * @returns true when there is something unsent.
 */
export function isDraft(text: string, attachments: number): boolean {
  return text.trim() !== '' || attachments > 0
}
