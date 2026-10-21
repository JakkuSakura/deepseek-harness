---
description: "Package map for the loop-hygiene guard family: the advisory repeat-tool reminder, the per-tool-call timeout policy, and the foreground-to-background hand-over, for users and maintainers choosing or composing the guards."
kind: "package-group"
---

# guard/ — loop-hygiene guard family

English | [中文](README.zh.md)

## Summary

The `guard/` group keeps the agent loop productive against three failure patterns. `repeat-tool-reminder` reminds the model when it repeats the same tool call, so a stuck loop changes approach or finishes. `timeout-policy` enforces a tool's declared time limit, so a hung call returns a clear error instead of stalling the session. `auto-background` moves a call that outlives its foreground window into a background job, so a slow call hands back its result instead of holding the turn. All three ship enabled in the `dsh` base bundle and can be tuned or removed.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Three small plugins cover the three patterns; each README below explains when to keep, tune, or remove it.

| Package | What it provides |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Reminds the model when it repeats the same tool call, so it changes approach or finishes |
| [`timeout-policy/`](timeout-policy/README.md) | Times out tool calls that declare a limit, so the model gets a clear error instead of waiting forever |
| [`auto-background/`](auto-background/README.md) | Moves a call that outlives its foreground window to a background job, so the turn keeps moving |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tools subsystem reference for the tool-call pipeline, then the reminder's configuration, the timeout-library decision behind the policy, and the job runtime the hand-over registers with.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the tool-call pipeline, the `detached` result, and the decisions all three guards build on.
- [Background task runtime](../../docs/subsystems/jobs.md) — the job registry `auto-background` hands a promoted call to.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted field of the repeat-call reminder.
- [Timeout deadline library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) — the timing/termination split `timeout-policy` enforces.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
