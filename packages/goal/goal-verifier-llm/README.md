---
description: "The independent LLM judge that certifies autonomous goal completion claims before the goal domain records them; for deployments that need a completion claim checked against recorded evidence."
kind: "package-reference"
---

# @deepseek-ai/dsh-goal-verifier-llm

English | [中文](README.zh.md)

## Summary

`dsh-goal-verifier-llm` supplies the `ctx.goalVerifier` provider for the goal domain's completion-certification extension point. When the model claims an autonomous goal round is complete, this package renders the recorded session evidence, asks a configured model to judge that evidence against the objective, and refuses the claim unless the judge explicitly certifies it. A refusal leaves the goal active and returns the judge's reason to the model as the failed tool call's message. Direct-human completions are not verified, because a human turn is already the authority for that decision.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package with `dsh-goal` and `dsh-tool-goal` when a deployment should not accept the model's own word that a goal is finished. It is opt-in: a composition without it keeps the goal domain's documented behavior, where the caller that records completion is authoritative.

```yaml
- name: '@deepseek-ai/dsh-goal'
- name: '@deepseek-ai/dsh-tool-goal'
- name: '@deepseek-ai/dsh-goal-verifier-llm'
  config:
    provider: deepseek-official
    model: deepseek-chat
```

| Field | Required | Default | Meaning |
|---|---|---|---|
| `provider` | yes | — | Registered provider route the judge call uses |
| `model` | yes | — | Exact model id the judge call uses |
| `maxTokens` | no | `1024` | Output-token cap for one judge reply |
| `maxEvidenceChars` | no | `20000` | Maximum evidence characters sent to the judge |

A blank `provider` or `model`, or a non-positive `maxTokens` or `maxEvidenceChars`, fails at load rather than on the first completion claim.

### What is verified

Only `update_goal` with `action: complete` under goal-round authority — the autonomous path where the model certifies its own work. Three other completion paths stay unchanged:

- A direct human turn on a top-level agent completes the goal without consulting the verifier.
- `/goal` (the `dsh-command-goal` package) never completes a goal.
- An in-process caller of `ctx.goals.complete()` is unaffected; the goal domain continues to treat direct service callers as trusted producers.

### Outcomes

| Judge reply | Effect |
|---|---|
| `VERDICT: COMPLETE` | The claim is recorded; the goal becomes `complete` and continuation disarms |
| `VERDICT: INCOMPLETE` | The claim is refused with the judge's reason; the goal stays active and its round continues |
| No usable verdict | Refused; an unusable answer never certifies completion |
| Provider error, abort, or truncation | The tool call fails; the goal stays active |

A refusal reaches the model as `Goal completion was not certified: <reason>`, so it can address the gap in the same turn or leave the goal active for the next round.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design

- **One auxiliary request, no agent-context change.** The judge runs through `ctx.llm.stream()` with its own system instruction and one user message. It never enters the agent's request history, adds no tools, and produces no session event of its own.
- **Evidence is a function of the log.** `renderGoalEvidence()` walks the immutable event cut the claiming tool call already holds — the same `events` its authority check captured — and renders `USER`, `ASSISTANT`, `CALL`, `RESULT`, and `ERROR` lines. Identical events and `maxEvidenceChars` always produce identical text, so the judge request is reconstructable from the session log plus configuration.
- **Bounded in both directions.** Each rendered item is clipped to a quarter of the evidence budget, the oldest items are dropped first and named by a leading marker, and one item that still exceeds the budget keeps its newest tail. The reply is capped by `maxTokens`.
- **Fail closed.** A missing `VERDICT:` line, an unrecognized verdict word, an errored or aborted stream, and a `max-tokens` truncation all refuse certification. Only the exact word `COMPLETE` certifies.
- **Revision-exact.** The request carries the `{ id, revision }` the claim cites and the `GoalView` the authority check resolved, so the judge and the claim describe the same revision.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `LlmGoalVerifier` service (`ctx.goalVerifier`), config validation, judge call, finish handling |
| [`src/evidence.ts`](src/evidence.ts) | Bounded, deterministic evidence transcript |
| [`src/prompt.ts`](src/prompt.ts) | Judge instruction, request text, strict verdict parser |
| [`../../goal/goal/src/verification.ts`](../../goal/goal/src/verification.ts) | The request, verdict, and service definition this package implements |

### Composition requirements

The service injects `llm`. The judge model is deployment configuration, not the agent's routed model, so verification costs and behavior stay predictable when a session switches models.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Goal group map](../README.md) — how the goal service, tools, command, and continuation driver compose.
- [dsh-tool-goal](../tool-goal/README.md) — the tool that consults this verifier and returns its refusal.
- [dsh-goal](../goal/README.md) — the durable goal domain and its completion authority rules.
- [Goal subsystem](../../../docs/subsystems/goal.md) — the certification types alongside the rest of the goal vocabulary.

-----

<a id="model-experience"></a>
## Model Experience

### Completion certification request

#### What the model sees

One auxiliary request the agent's own history never contains: the verifier instruction as the request's system text, and a user message carrying the objective, the admitted-round count, and the evidence transcript. A refusal returns to the agent as the failed `update_goal` result, which the tool layer renders.

##### Verifier instruction, verbatim

```markdown
You are an independent verifier deciding whether an autonomous agent goal is complete.
Judge only from the goal objective and the recorded session evidence you are given. You did not do the work, and you cannot run commands or read files.

Rules:
- Answer COMPLETE only when the evidence establishes that every part of the objective is finished, with observed results rather than the agent's own claims.
- Answer INCOMPLETE when work remains, when the evidence contradicts the claim, when a result is missing, or when you cannot tell.
- Effort spent, a plan described, or a promise to continue are not evidence of completeness.

Reply with exactly two lines and nothing else. The first line is `VERDICT: COMPLETE` or `VERDICT: INCOMPLETE`.
The second line is `REASON: <one sentence>` explaining the decision.
```


#### Token effect

One additional model request per autonomous completion claim. Its input is bounded by `maxEvidenceChars` (20000 characters by default) plus the objective and the fixed instruction; its output is bounded by `maxTokens`.

#### KV Cache effect

Independent: the request shares no prefix with the conversation, so it neither reuses nor invalidates the provider cache for the agent's own requests.

## Known Limitations and Deferred Work

- **Same-model blind spots** — the judge is a model, and the default deployment may configure the same model the agent used; a shared misreading of the evidence passes both. Only an independently configured model and evidence standard reduce that overlap.
- **Session evidence only** — the judge reads the recorded transcript, not the workspace. Work whose proof exists only as current file contents, and never as a tool result in the session, cannot be certified.
- **No durable verdict record** — the verdict reaches the session only through the tool result of a refusal. A certified completion leaves the judge's own output outside the log; the request stays reconstructable from the goal event, the evidence cut, and this package's configuration.
- **No blocking certification** — `update_goal action=blocked` keeps its round-count threshold; this package verifies completion claims only.
- **Unclassified auxiliary request** — the judge call leaves `GenerateOptions.purpose` unset, so adapters treat it as an ordinary request.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Open, undecided directions: a durable `goal/verification` session event so certified verdicts are auditable in the log, a `purpose` classification for the auxiliary request so adapters can apply purpose-specific generation policy, a deterministic command-check verifier for deployments that want mechanical rather than model judgment, and an evidence source that lets the judge inspect the workspace instead of only the log.

</details>
