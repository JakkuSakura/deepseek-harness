# Agent Note: Model-visible context usage

Status: implemented

English | [中文](2026-10-19-model-visible-context-usage.zh.md)

## Problem

A model in a long session has no observation of its own context budget. When a goal round or a compaction checkpoint made the remaining work look large, `deepseek-flash` inferred exhaustion from its own narration, narrowing or stopping work while most of the window was free: in one recorded session it reported "little context left" at 252,175 of a 1,000,000-token window ([discussion #6736](https://github.com/deepseek-ai/deepseek-harness/discussions/6736) reports the same behavior at 51%). The only number in that prompt that resembled a budget was the goal round's `Round: N/M`; the only other context-scarcity text was a compaction checkpoint, which describes a past reduction rather than current occupancy.

## Decision

`@deepseek-ai/dsh-token-meter` registers one runtime-context section, `token:usage`, through the optional `ctx.systemPrompt` service at the newly allocated `CONTEXT_USAGE` order, 100, before the sandbox and approval policies. The section renders one sentence, reading the `contextPressure` projection whose semantics the [occupancy note](2026-07-29-projected-token-usage-and-request-context.md) owns: the projection's `projectedTokens` (falling back to `pressureTokens`) against its `contextWindow`, for example "Context usage: about 250,000 of the 1,000,000-token context window is in use (25%, about 750,000 tokens free)."

Reported values round to the nearest 5% of the window, and any nonzero use reports at least one step, so a session appends a superseding snapshot only when occupancy crosses a step. The section is silent until both a provider sample and an advertised window exist, and it contributes nothing to an agentless assembly. The loop materializes the snapshot as a durable user message only when its text changes, which is what keeps the line reconstructable from the session log.

## Reporting contract

The model and the conversation status display read the same projection, so a user who sees 25% occupied in the GUI sees the same figure in the prompt. The line does not decide when compaction runs: compaction continues to read `measure()`, and the percentage can lag one request behind a model switch because the projection pairs the newest usage sample with the newest advertised window independently.

## Alternatives considered

- **Report the compaction threshold instead of the window.** Rejected: the threshold belongs to a compaction backend that may not be mounted, so the meter would take on policy it does not own. The window is adapter-declared and meaningful on every route that advertises one.
- **Report exact token counts on every step.** Rejected: the runtime-context snapshot is append-only, so an exact figure appends a message every step and accumulates superseded snapshots.
- **Keep the meter model-invisible and render the line from compaction.** Rejected: compaction is optional, its pre-step measurement runs after prompt assembly, and the claims appear before the first compaction ever runs.

## Consequences

The meter now contributes model-visible content when a prompt registry is mounted; measurement still works in compositions without one. The figure is a coarse reference: it rounds, it is not a threshold, and the reported figure near a step boundary can differ by up to half a step from exact occupancy. Snapshots gain one runtime-context message where a window and usage exist; no event type, wire field, or configuration setting changes.
