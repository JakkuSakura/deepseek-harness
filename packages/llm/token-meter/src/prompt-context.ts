/**
 * Model-facing context-usage line for the runtime-context snapshot.
 *
 * The model has no other observation of its context budget, so without this
 * section it can treat a session as running out of context while most of the
 * window is free. The section renders the same occupancy the conversation
 * status display reads — the `contextPressure` projection's projected prompt
 * size against the newest advertised window — in window fractions, so a session
 * appends a new snapshot only when occupancy crosses a step.
 * @module @deepseek-ai/dsh-token-meter/prompt-context
 */

import type { ContextPressureProjection } from './projection.ts'

/**
 * Window fraction at which the rendered line changes. Five percent is fine
 * enough for small and million-token windows, and coarse enough to bound the
 * superseded snapshots a long session writes.
 */
const REPORT_STEP = 0.05

/** Render a token count with deterministic thousands separators. */
function count(tokens: number): string {
  return String(Math.round(tokens)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Render the context-usage line for one prompt assembly.
 *
 * Occupancy is {@link ContextPressureProjection.projectedTokens} when known,
 * otherwise the newest provider sample, which is the figure a user sees.
 * Reported values round to the nearest {@link REPORT_STEP} of the window, and
 * any nonzero use reports at least one step, so the text changes only when
 * occupancy crosses a step.
 * @param pressure - newest context-pressure projection for the assembling
 *   session; absent until a provider reports usage or a route advertises a
 *   window.
 * @returns one model-facing sentence, or `''` when occupancy is not yet known.
 */
export function renderContextUsage(pressure: ContextPressureProjection | undefined): string {
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens
  const contextWindow = pressure?.contextWindow
  if (used === undefined || contextWindow === undefined) return ''
  const step = contextWindow * REPORT_STEP
  const reported = Math.min(
    contextWindow,
    used <= 0 ? 0 : Math.max(step, Math.round(used / step) * step),
  )
  const percent = Math.round(reported / contextWindow * 100)
  return `Context usage: about ${count(reported)} of the ${count(contextWindow)}-token context window `
    + `is in use (${percent}%, about ${count(contextWindow - reported)} tokens free).`
}
