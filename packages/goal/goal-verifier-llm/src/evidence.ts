/**
 * Deterministic rendering of a session event cut into bounded verifier
 * evidence. The same events and budget always produce the same transcript, so
 * the judge's input is a function of the logged session plus configuration.
 * @module @deepseek-ai/dsh-goal-verifier-llm/evidence
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Prefix added when the oldest evidence did not fit the character budget. */
const OMITTED_MARKER = '[earlier evidence omitted]'

/** Smallest per-item rendering budget; one item must still say something. */
const MIN_ITEM_CHARS = 64

/** Render message content, naming blocks this verifier does not read. */
function renderContent(content: readonly ContentBlock[]): string {
  return content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n')
}

/** Clip one rendered item and report how much was dropped. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}… (${text.length - limit} chars omitted)`
}

/** Render one event as an evidence line, or `undefined` when it carries none. */
function renderEvent(event: SessionEvent, itemLimit: number): string | undefined {
  switch (event.type) {
    case 'user/message':
      return clip(`USER: ${renderContent(event.data.content)}`, itemLimit)
    case 'assistant/message':
      return clip(`ASSISTANT: ${renderContent(event.data.message.content)}`, itemLimit)
    case 'tool/call':
      return clip(`CALL ${event.data.name}: ${event.data.arguments}`, itemLimit)
    case 'tool/result':
      return clip(
        `${event.data.message.isError === true ? 'ERROR' : 'RESULT'}: ${renderContent(event.data.message.content)}`,
        itemLimit,
      )
    default:
      return undefined
  }
}

/**
 * Render the session cut into one oldest-first evidence transcript.
 *
 * Newest events are kept when the transcript exceeds the budget; the oldest are
 * dropped and named by a leading marker. Every rendered item is clipped to a
 * quarter of the budget so one oversized tool result cannot crowd out the rest.
 * @param events - immutable session cut taken by the claiming caller.
 * @param maxChars - maximum characters in the returned transcript.
 * @returns the evidence transcript, empty when the cut carries no readable event.
 */
export function renderGoalEvidence(events: readonly SessionEvent[], maxChars: number): string {
  const itemLimit = Math.min(maxChars, Math.max(MIN_ITEM_CHARS, Math.floor(maxChars / 4)))
  const lines: string[] = []
  for (const event of events) {
    const line = renderEvent(event, itemLimit)
    if (line !== undefined && line.trim().length > 0) lines.push(line)
  }
  const markerCost = OMITTED_MARKER.length + 1
  // First index whose suffix fits the budget; the whole transcript when it need not shrink.
  const keepTail = (budget: number): number => {
    let start = 0
    let total = lines.reduce((sum, line) => sum + line.length + 1, 0)
    // Keep at least the newest line even when it alone exceeds the budget.
    while (total > budget && start < lines.length - 1) {
      const dropped = lines[start]
      /* v8 ignore next -- the loop condition keeps `start` inside `lines` */
      if (dropped === undefined) break
      total -= dropped.length + 1
      start += 1
    }
    return start
  }
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0)
  // Reserve the marker before choosing where to cut, so a trimmed transcript
  // still explains the omission. A budget too small for that keeps the newest
  // lines instead.
  const reserved = total > maxChars && maxChars > markerCost ? maxChars - markerCost : maxChars
  const start = keepTail(reserved)
  if (start === lines.length) return ''
  const body = lines.slice(start).join('\n')
  const rendered = start > 0 && body.length + markerCost <= maxChars
    ? `${OMITTED_MARKER}\n${body}`
    : body
  // One item can still exceed the budget when the budget is tiny; the tail is
  // the newest and therefore the most relevant part.
  return rendered.length <= maxChars ? rendered : rendered.slice(rendered.length - maxChars)
}
