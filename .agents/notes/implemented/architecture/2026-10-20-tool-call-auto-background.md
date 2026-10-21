# Agent Note: Detached tool results and the foreground-to-background hand-over

Status: implemented

English | [中文](2026-10-20-tool-call-auto-background.zh.md)

## Problem

A `tools/execute` wrapper that awaits the rest of the chain cannot bound how long a turn waits on one tool. The only shipped way for a call to escape that wait is for the tool itself to own a background job — `bash` registers one and promotes at its own timeout — so every other long call holds its step until it settles. A generic wrapper cannot simply return early: the registry validates a wrapper's success result against the owning tool's output declaration, and it freezes the execution at commit, so a body still running would throw when it restores `exec.signal`.

## Decision

`packages/guard/auto-background` wraps `tools/execute` and moves an eligible call to a `tool` job once `backgroundAfterMs` passes (5,000 ms in `dsh-base`). The model receives the hand-over notice; the call's eventual output is appended to the job's ring and read with `job_output`.

`ToolExecutionSuccess` gains `detached?: true`. It marks a wrapper result whose `content` is a hand-over notice rather than the tool's output, so `normalizeDispatchResult` commits it without output-declaration validation and with `value: null`. The marker is host-only and never persisted: a replay reads the notice as an ordinary successful result.

- **Eligibility.** A call is detached only when it is model-direct (`exec.parent` absent, because a `run_code` sub-dispatch owes its value to the awaiting program), session-owned (`exec.agent` present, because that session's job controller must collect and stop the work), and outside `exclude`. The default exclusion list is `job_output`, `job_kill`, `job_list`, `ask_user_question`, and `exit_plan_mode`: a job wait must not spawn a job, and a prompt that settles only on a human answer must not leave its question open while the turn continues.
- **Signal ownership.** Before delegating, the wrapper installs its own `AbortController` signal. The registry fuses it with the caller signal for the body, and the wrapper keeps the controller as the job's cancellation handle, so `job_kill` reaches the tool.
- **Frozen executions.** An execution is committed and frozen while a detached body still runs. `dispatchToolBody` and the wrapper therefore skip the signal restore once the execution is frozen, so settlement cannot throw on a property no reader owns anymore.
- **Best-effort registration.** A refused `ctx.jobs.start` (no controller, the owner's job limit) logs a warning and awaits the call in the foreground instead of losing it.

A tool's own cooperative budget stays separate: [`tool-call-timeout-policy`](2026-07-07-tool-call-timeout-policy.md) keeps enforcing the declared `timeoutMs`, and a detached call keeps that deadline because the timeout wrapper's signal sits in the same dispatch chain. The registry and hand-over semantics the job uses are owned by the [jobs seam consolidation](2026-09-03-jobs-seam-consolidation.md).

## Consequences

- A detached call's outcome bypasses `tools/post-execute`, `projectContent`, `finalizeContent`, and the spill and pruning policies, because the pipeline has already committed the hand-over. Its content is bounded by the job ring's retention instead.
- Non-text content blocks are named in the ring rather than carried, so an image result loses its payload in the hand-over.
- Killing a job aborts the dispatch signal; a tool that ignores cancellation keeps running while the record reports `killed`. Cancellation stays cooperative, like every other tool-call path.
- Tools that own their own job may nest: a promoted `bash` call produces an outer `tool` job whose output can mention the inner job id.
- Every composition that mounts the plugin needs `ctx.jobs` and an attached controller; the plugin stays inactive otherwise rather than silently running everything in the foreground.

## Testing

- `packages/guard/auto-background/tests/auto-background.spec.ts` drives the real tool pipeline, job registry, and job tools: in-window pass-through, hand-over, an error settlement, kill through the job, `include`/`exclude` scope, an unowned call, and disposal of the plugin fiber.
- `packages/core/tools/tests/tools.spec.ts` pins the detached pass-through with a tool whose output declaration rejects `value: null`, proving validation is skipped rather than relaxed.
- The `dsh-base` row runs the hand-over in the shipped composition.

## Alternatives considered

**Return an error result instead of a detached marker.** The pipeline accepts wrapper-authored failures without output validation, so this needs no core change. It marks still-running work as a failure in the transcript and every UI surface, and it invites the model to retry a call that is already in flight.

**Register a job for every call and remove it when the call settles (the `bash` pattern).** This keeps the pipeline awaiting and avoids early return. It consumes a job ordinal and churns a visible record for every fast call, and it still needs the wrapper to release the call before it settles.

**Require each tool to own its hand-over.** That is the limitation the plugin removes: it forces every long-running tool to adopt the job seam, and leaves third-party tools unable to bound their turn.

**Extend the agent loop instead.** The tool pipeline owns per-call waiting and cancellation; a loop change would duplicate the job seam and break the rule that new behavior goes on documented extension points.
