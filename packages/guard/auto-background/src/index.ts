/**
 * Foreground time limit for tool calls: a call that outlives
 * `backgroundAfterMs` moves to a background job, so the owning turn stops
 * waiting and the eventual result arrives through `job_output`.
 *
 * The wrapper owns the deadline, the job registration, and the model-facing
 * hand-over text. It owns no termination: a promoted call is stopped only when
 * the job is killed or its owner is torn down, and both reach the tool through
 * the dispatch signal the wrapper installs.
 *
 * @module @deepseek-ai/dsh-tool-call-auto-background
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    /** One tool call that outlived its foreground window. */
    tool: 'tool'
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-call-auto-background'

/**
 * The tool registry this plugin wraps (`tools/execute`) and the job registry it
 * moves long calls to (`jobs`). Both are required: a composition without a job
 * registry has nowhere to move work to, and silently running every call in the
 * foreground would hide that misconfiguration.
 */
export const inject = ['tools', 'jobs']

/**
 * Tools never moved to the background by default. `job_output` waits on another
 * job, so wrapping it would build a job on top of the wait it exists to
 * perform. `ask_user_question` and `exit_plan_mode` settle only when a human
 * answers, and the next step needs that answer: handing them over would leave
 * the question open while the turn ran on.
 */
const DEFAULT_EXCLUDE: readonly string[] = [
  'job_output',
  'job_kill',
  'job_list',
  'ask_user_question',
  'exit_plan_mode',
]

/** Characters of the canonical arguments quoted in a job label. */
const LABEL_PREVIEW_CHARS = 120

/**
 * Which calls may move to the background and after how long. Every deployment-
 * varying choice is a field here; a composition that needs different tools
 * overrides `include` or `exclude` rather than editing the plugin.
 */
export interface Config {
  /** Milliseconds a call may run before the turn stops waiting (default 5000). */
  backgroundAfterMs?: number
  /** Tool names eligible for the hand-over; empty means every tool (default `[]`). */
  include?: string[]
  /** Tool names never moved to the background (default: the job-control and human-blocking tools). */
  exclude?: string[]
}

/** Runtime configuration schema for the auto-background plugin. */
export const Config: z<Config> = z.object({
  backgroundAfterMs: z.number().min(1).default(5_000),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([...DEFAULT_EXCLUDE]),
})

/**
 * Register the `tools/execute` wrapper. A call whose tool is eligible and whose
 * execution belongs to a session is dispatched under a wrapper-owned signal; it
 * either settles inside the window and returns its own result, or is registered
 * with `ctx.jobs` and replaced by the hand-over result.
 *
 * @param ctx - context carrying the tool registry and the job registry.
 * @param config - the deadline and the tool scope.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const backgroundAfterMs = config.backgroundAfterMs ?? 5_000
  if (!Number.isFinite(backgroundAfterMs) || backgroundAfterMs <= 0) {
    throw new Error(`tool-call-auto-background: backgroundAfterMs must be a positive finite number, got ${String(backgroundAfterMs)}`)
  }
  const include = new Set(config.include ?? [])
  const exclude = new Set(config.exclude ?? DEFAULT_EXCLUDE)
  const eligible = (toolName: string): boolean =>
    (include.size === 0 || include.has(toolName)) && !exclude.has(toolName)

  ctx.on('tools/execute', (exec, next) => {
    // A nested dispatch (a tool called from inside a `run_code` program) owes
    // its value to the program that awaits it, so it is never detached.
    // Only a session-owned call has an owning agent whose job controller can
    // collect and stop the promoted work, so an unowned call keeps its
    // foreground behavior.
    const owner = exec.agent?.id
    if (owner === undefined || exec.parent !== undefined || !eligible(exec.name)) return next()
    return foregroundOrJob(ctx, exec, next, backgroundAfterMs, owner)
  })
}

/**
 * Race one dispatch against the foreground window and hand the still-running
 * call to the job registry when the window closes.
 *
 * @param ctx - context carrying the job registry.
 * @param exec - the call about to dispatch.
 * @param next - the rest of the `tools/execute` chain, ending in the tool body.
 * @param backgroundAfterMs - how long the turn may wait for the call.
 * @param owner - the session whose job controller collects and stops the work.
 * @returns the call's own result, or the hand-over result naming its job.
 */
async function foregroundOrJob(
  ctx: Context,
  exec: ToolDispatchExecution,
  next: () => Promise<ToolExecutionResult>,
  backgroundAfterMs: number,
  owner: SessionId,
): Promise<ToolExecutionResult> {
  const callerSignal = exec.signal
  const controller = new AbortController()
  // The rest of the chain reads `exec.signal` synchronously when `next()` is
  // called, so the swap lands before the tool body starts. Keeping it on `exec`
  // until the body settles is what lets a later `job_kill` reach the tool.
  exec.signal = controller.signal
  const dispatched = next()
  const settled = (async () => {
    try {
      return { ok: true as const, result: await dispatched }
    } catch (error: unknown) {
      return { ok: false as const, error }
    } finally {
      // The registry freezes a detached execution when the hand-over result is
      // finalized, long before this body settles; restoring the caller signal
      // then has no reader and would throw on the frozen property.
      if (!Object.isFrozen(exec)) exec.signal = callerSignal
    }
  })()

  const expiry = Promise.withResolvers<{ kind: 'expired' }>()
  const timer = setTimeout(() => { expiry.resolve({ kind: 'expired' }) }, backgroundAfterMs)
  const first = await Promise.race([
    settled.then(outcome => ({ kind: 'settled' as const, outcome })),
    expiry.promise,
  ])
  clearTimeout(timer)

  if (first.kind === 'settled') {
    if (!first.outcome.ok) throw first.outcome.error
    return first.outcome.result
  }

  let id: JobId
  try {
    id = ctx.jobs.start({
      kind: 'tool',
      label: jobLabel(exec.name, exec.arguments),
      owner,
      run: (job) => {
        let stopping = false
        // Appends land before `done` settles, so the completion notice and the
        // first `job_output` read the whole result the foreground call would
        // have returned.
        const done: Promise<JobOutcome> = settled.then((outcome) => {
          // Cancellation supersedes whatever the dispatch settled with: a
          // killed job reports `killed`, and the registry appends its own
          // recorded kill reason.
          if (controller.signal.aborted) return { status: 'killed' as const }
          if (callerSignal.aborted) {
            return { status: 'killed' as const, detail: abortDetail(callerSignal) }
          }
          if (!outcome.ok) {
            const message = errorMessage(outcome.error)
            job.append(`${message}\n`)
            return { status: 'failed' as const, detail: message }
          }
          job.append(renderContent(outcome.result.content))
          return outcome.result.isError
            ? { status: 'failed' as const, detail: outcome.result.error.message }
            : { status: 'completed' as const }
        })
        return {
          done,
          // The kill reaches the tool through the signal its body was
          // dispatched with; a tool that ignores it keeps running, which is
          // the same cooperative limit every other cancellation has.
          cancel: (reason) => {
            if (stopping) return
            stopping = true
            controller.abort(reason === undefined ? new Error('background job stopped') : reason)
          },
        }
      },
    })
  } catch (error: unknown) {
    // Admission refused the job (no controller, the owner's job limit). The
    // call keeps its foreground behavior rather than being lost.
    ctx.logger.warn(`tool-call-auto-background: the job registry refused ${exec.name}; the call keeps running in the foreground: ${String(error)}`)
    const outcome = await settled
    if (!outcome.ok) throw outcome.error
    return outcome.result
  }

  return promotedResult(exec.name, backgroundAfterMs, id)
}

/**
 * The model-facing result substituted when the window closes: the still-running
 * marker and how to collect or stop the promoted call.
 *
 * @param toolName - the dispatched tool.
 * @param backgroundAfterMs - the window that elapsed, rendered into the marker.
 * @param id - the registry-issued job id.
 * @returns a detached, non-error result carrying only the hand-over text.
 */
function promotedResult(toolName: string, backgroundAfterMs: number, id: JobId): ToolExecutionResult {
  const text = `[still running after ${backgroundAfterMs}ms; moved to background job ${id}]\n`
    + `The ${toolName} call keeps running in the background. You will be notified when it finishes; `
    + 'read its result with job_output, stop it with job_kill.'
  return { isError: false, detached: true, value: null, content: [{ type: 'text', text }] }
}

/**
 * One-line job label: the tool name and a bounded preview of its arguments.
 *
 * @param toolName - the dispatched tool.
 * @param args - the call's canonical arguments.
 * @returns the label shown in the job roster and completion notices.
 */
function jobLabel(toolName: string, args: unknown): string {
  const preview = JSON.stringify(args).replaceAll(/\s+/g, ' ').trim()
  return `${toolName}: ${preview.length <= LABEL_PREVIEW_CHARS ? preview : `${preview.slice(0, LABEL_PREVIEW_CHARS)}…`}`
}

/**
 * Flatten a settled tool result's content into the text the job ring carries.
 * Every block type the ring cannot carry is named instead of dropped silently.
 *
 * @param content - the settled result's content blocks.
 * @returns one text block per line, in block order.
 */
function renderContent(content: readonly ContentBlock[]): string {
  return content.map(block => block.type === 'text'
    ? block.text
    : `[${block.type} content is not carried into a background job]`).join('\n')
}

/**
 * Render a thrown dispatch failure for the job ring.
 *
 * @param error - the value the dispatch rejected with.
 * @returns the message the model reads with `job_output`.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Render an abort signal's reason for a killed job's detail.
 *
 * @param signal - the aborted signal that ended the call.
 * @returns the terminal reason shown by the job roster and completion notices.
 */
function abortDetail(signal: AbortSignal): string {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason.message : String(reason)
}
