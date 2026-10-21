---
description: "Foreground time limit for tool calls: moves a call that outlives its window to a background job and returns the hand-over result, for users choosing, tuning, or debugging the guard."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-call-auto-background

English | [中文](README.zh.md)

## Summary

Use this package to stop one tool call from holding a turn for an unbounded time. A call that outlives its window (`backgroundAfterMs`, 5,000 ms by default) moves to a background job: the model receives a hand-over result naming that job, and the call's eventual output arrives through `job_output` like any other background work. The plugin is one `tools/execute` wrapper, needs no tool changes, and is enabled in the `dsh` base bundle.

## Table of Contents

- [Use this package](#use-this-package)
  - [When to choose it](#when-to-choose-it)
  - [Setting it up](#setting-it-up)
  - [What you get](#what-you-get)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add the plugin to a composition and a slow call stops blocking its turn; the `dsh` base bundle already has it at 5,000 ms.

### When to choose it

Choose it when a turn must keep moving while a tool works — a long build, a subagent delegation, a slow fetch — and receiving the result one job round-trip later is acceptable. Avoid it for tools whose answer decides the immediate next step and cannot be deferred, and for tools that settle only when a human answers; the default `exclude` already keeps the shipped human-blocking tools out.

### Setting it up

```yaml
- id: tool-call-auto-background
  name: '@deepseek-ai/dsh-tool-call-auto-background'
  config:
    backgroundAfterMs: 5000
    include: []
    exclude:
      - job_output
      - job_kill
      - job_list
      - ask_user_question
      - exit_plan_mode
```

| field | default | meaning |
|---|---|---|
| `backgroundAfterMs` | `5000` | Milliseconds a call may run before the turn stops waiting. Must be a positive finite number. |
| `include` | `[]` | Tool names eligible for the hand-over; empty means every tool. |
| `exclude` | the five names above | Tool names never moved, checked after `include`. |

The composition must also provide `ctx.jobs` (a job registry such as `@deepseek-ai/dsh-jobs-local`) and the controller that `@deepseek-ai/dsh-tool-jobs` attaches. Without them the plugin stays inactive rather than silently running every call in the foreground.

### What you get

A call that settles inside the window returns exactly its own result and registers no job. A call that outlives the window returns `[still running after <ms>ms; moved to background job <id>]` plus the job hand-off guidance, and keeps running as a job owned by the calling session: it appears in `job_list`, its eventual output is read with `job_output`, and `job_kill` stops it. Killing the job aborts the call through the signal its body was dispatched with, so a tool that honors cancellation stops; the job settles `killed` with the kill reason. Cancelling the call itself also kills the job.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The wrapper owns the foreground deadline, the job registration, and the hand-over text. It owns no termination: a promoted call stops only when the job is killed or its owner is torn down.

**Who is eligible.** A call is promoted when it is model-direct (`exec.parent` is absent, so a `run_code` sub-dispatch is never detached), belongs to a session (`exec.agent` is present, because the session's job controller collects and stops the work), and passes `include`/`exclude`.

**Signal swap.** Before delegating, the wrapper installs its own `AbortController` signal on `exec.signal`; the registry reads that property synchronously inside `next()` and fuses it with the caller's signal for the body. The wrapper keeps the controller as the job's cancellation handle, so `job_kill` reaches the tool, and restores the caller signal once the body settles.

**The race.** `next()` starts immediately and the wrapper races it against a timer. When the call wins, its result is returned unchanged. When the timer wins, `ctx.jobs.start` registers a `tool` job whose producer adopts the still-pending dispatch; a refused registration (no controller, the owner's job limit) logs a warning and falls back to awaiting the call in the foreground, so a promoted call is never lost.

**The detached result.** The wrapper returns a success result marked `detached`, so the registry commits the hand-over content without validating it against the tool's output declaration — no canonical value exists yet. Once the body settles, the job appends the tool's rendered content to its output ring and settles; a thrown or error result settles the job `failed` with its message, and cancellation settles it `killed`.

**Why the execution stays mutable.** The pipeline freezes an execution when it commits the hand-over, while the detached body still runs. Both the body's own signal restore and the wrapper's skip a frozen execution, so settlement cannot throw on a property that no reader owns anymore.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `name`/`inject`/`Config`/`apply`, the `tools/execute` wrapper, job registration, and the hand-over text |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `tools/execute` waterfall, the `detached` result, and cancellation.
- [Background task runtime](../../../docs/subsystems/jobs.md) — the `ctx.jobs` contract, ownership, and the output ring.
- [jobs group](../../jobs/README.md) — the registry, its local implementation, and the model-facing job tools.
- [guard group map](../README.md) — the sibling loop-hygiene guards.

-----

<a id="model-experience"></a>
## Model Experience

### Conditional tool result

#### What the model sees

A call that settles inside the window is invisible: the model reads the tool's own result. A call that outlives the window is replaced by `[still running after <ms>ms; moved to background job <id>]` followed by one sentence telling the model the call keeps running, that a completion notice follows, and that `job_output` reads it while `job_kill` stops it. The exact text is pinned in [`src/index.ts`](src/index.ts). No prompt section or tool schema is added.

#### Token effect

Zero added tokens while calls settle inside the window. A hand-over costs one small result plus the tool's eventual output when the model reads it, which it would have paid inline anyway.

#### KV Cache effect

Append-only: the hand-over result is a new tool result after the reusable request prefix, and later `job_output` content also appends, so existing KV Cache entries stay valid.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints, not a task backlog.

- **Cooperative cancellation only.** Killing a promoted job aborts its signal; a tool that ignores cancellation keeps running while the job record reports `killed`. Nothing can hard-stop same-process code.
- **The detached result bypasses result policies.** Because the pipeline has already committed the hand-over, the eventual output never passes through `tools/post-execute`, `projectContent`, `finalizeContent`, or the spill and pruning policies. It is appended to the job's output ring instead, bounded by that ring's retention.
- **Non-text blocks are named, not carried.** A text result reaches the job verbatim; an image or file block becomes `[<type> content is not carried into a background job]`.
- **Self-managing tools nest.** `bash` and the other shell tools already register their own job while a foreground call waits, so a promoted shell call produces an outer `tool` job whose output may mention the inner job id. Their own timeout promotion still applies inside.
- **Only session-owned, model-direct calls are promoted.** An unowned call, a `run_code` sub-dispatch, and a call made while no job controller is attached keep the foreground behavior.
- **A refused registration falls back.** When the job registry rejects the start (no controller, the owner's job limit), the call keeps waiting in the foreground and a warning is logged; the hand-over is best-effort, never a data loss.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative.

- The default exclusion list is the safety boundary that keeps a job wait (`job_output`) from spawning a job and a human-blocking prompt (`ask_user_question`, `exit_plan_mode`) from leaving its question open while the turn runs on. Extending it is a product decision, not a tuning tweak.
- The `detached` marker on `ToolExecutionSuccess` exists for this hand-over; a wrapper that returns one takes responsibility for the call's eventual outcome, and the pipeline stops observing it.
- Whether the shipped base-bundle window should stay at 5,000 ms for every tool is open pending product evidence; `include` narrows it per deployment without a code change.

</details>
