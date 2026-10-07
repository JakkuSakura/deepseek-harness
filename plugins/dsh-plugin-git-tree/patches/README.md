# Patches to the installed DeepSeek Harness

These are not part of the plugin. They change **DSH's own code**, which ships as
built packages with no sources — so each patch is a literal find-and-replace
against a build artefact, and each one **fails loudly** rather than half-applying
when the code it targets has moved.

A DSH upgrade reverts them. `node patches/apply.mjs` is how they come back.

```
node patches/apply.mjs            # apply what is missing
node patches/apply.mjs --check    # report only, change nothing
node patches/apply.mjs --revert   # undo, where the text still matches
node patches/apply.mjs --root DIR # look under DIR instead of the defaults
```

After applying, **restart `dsh web`**: both patches touch code that is loaded at
boot — one half is a Host package, the other a client bundle.

Every patched file is parsed (`node --check` on a `.mjs` copy) before the script
exits, so a patch that produced invalid JavaScript cannot pass silently.

**Change a patch only after reverting it.** A patch describes one transition —
original to final — so editing a definition while files hold the *older* patched
form leaves them in a state no definition describes, and the harness will refuse
them rather than guess. Revert first, then edit, then apply.

## The patches

### `tok-per-second`

The composer's `tok/s` is `StatsPills` dividing `decodeTokens` by `decodeMs` from
the `sessionStats` projection. That projection is **whole-log by design**, so the
figure is the Session's lifetime decode average — it converges and then barely
moves, which is what makes it read as "not real time" while a turn streams.

The projection already sees every event's `time`, so the window is taken there:
each finished step contributes its decode wall time and output tokens, entries
older than **15 seconds** are dropped, and the two scalars become their sum.

No client change is needed — both fields are consumed in exactly one place, that
division — so narrowing what they mean narrows the rate and nothing else.

**Known limit — and it is a real one.** The window can only move when the log does,
and the log carries **one `assistant/message` per step**, not per token. So the
figure ticks at step boundaries and sits still through a single long generation.

There is no host-side fix: a projection sees the durable log, and the tokens are not
in it. The client is the only place that sees them — it receives
`assistant/live-chunk` events, each with a `time`. A genuinely per-second rate is
therefore a **client** feature, not a patch: subscribe to the session's event source,
keep a 15-second window of chunks, and draw the figure. It would live in the plugin,
beside the pill it replaces.

### `goal-editor`

The goal bar edits its objective in an `<input type="text">`, so a goal spanning
several lines cannot be edited: an input's value cannot contain newlines, and the
HTML spec strips them on the way in. The patch makes it a `textarea` — the control
that holds one — and drops the `type` attribute, which is invalid there.

## What is not here yet

The transcript truncates a long running command with an ellipsis, and the element
that does it has not been identified — it is neither CSS-clipped nor the approval
card's command. Until the row is inspected in a live DOM, a patch would be a guess.
