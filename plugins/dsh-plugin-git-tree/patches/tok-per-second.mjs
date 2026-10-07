/**
 * Make the composer's tok/s figure a rate over the last 15 seconds.
 *
 * The figure is `StatsPills` dividing `decodeTokens` by `decodeMs` from the
 * `sessionStats` projection. That projection is whole-log by design, so the result
 * is the Session's lifetime decode average: it converges and then barely moves,
 * which is why it reads as "not real time" while a turn is streaming.
 *
 * No client change is needed. Both fields are consumed in exactly one place — that
 * division — so narrowing what they mean narrows the rate and nothing else.
 *
 * The fold already sees every event's `time`, so the window is taken there: each
 * finished step contributes its decode wall time and output tokens, entries older
 * than the window are dropped, and the two scalars become their sum. The figure
 * therefore freezes at its last value once a turn stops, because a projection is
 * only re-published when the log grows.
 *
 * Three details are load-bearing, and the first two were wrong in the first version
 * of this patch:
 *
 * - The window is a **new array**, never a `push`. `next` is spread from `state`, so
 *   they share the array; pushing into it mutates the state the projection is still
 *   holding and compares by identity.
 * - The state schema is `strict` and validates persisted-cache rows. A row carrying
 *   the window must be declared, or it is rejected — and a row parsed through the
 *   schema would come back without the field, leaving the fold to spread `undefined`.
 * - The anchor for the initial state spans two lines so it is not a prefix of its own
 *   replacement: a find string like that matches after being applied, which is how a
 *   copy got patched twice.
 */
export default {
  id: 'tok-per-second',
  summary: 'composer tok/s becomes a 15-second window instead of a lifetime average',
  package: '@deepseek-ai/dsh-session-stats',
  file: 'lib/index.js',
  replacements: [
    {
      find: '\t\tdecodeMs: 0,\n\t\tdecodeTokens: 0,',
      replace: '\t\tdecodeMs: 0,\n\t\tdecodeSteps: [],\n\t\tdecodeTokens: 0,',
    },
    {
      find: '\t\t\t\t\t\tnext.decodeMs += Math.max(0, event.time - firstToken);\n\t\t\t\t\t\tnext.decodeTokens += outputTokens;',
      replace: '\t\t\t\t\t\t// A new array, never a push: `next` shares its array with the state it was\n\t\t\t\t\t\t// spread from, and the projection compares states by identity.\n\t\t\t\t\t\tnext.decodeSteps = [...next.decodeSteps, {\n\t\t\t\t\t\t\ttime: event.time,\n\t\t\t\t\t\t\tms: Math.max(0, event.time - firstToken),\n\t\t\t\t\t\t\ttokens: outputTokens\n\t\t\t\t\t\t}].filter((step) => step.time >= event.time - 15000);\n\t\t\t\t\t\tnext.decodeMs = next.decodeSteps.reduce((total, step) => total + step.ms, 0);\n\t\t\t\t\t\tnext.decodeTokens = next.decodeSteps.reduce((total, step) => total + step.tokens, 0);',
    },
    {
      find: '\tpendingCalls: z.record(z.string(), z.number().nonnegative())\n});',
      replace: '\tpendingCalls: z.record(z.string(), z.number().nonnegative()),\n\tdecodeSteps: z.array(z.object({\n\t\ttime: z.number().nonnegative(),\n\t\tms: z.number().nonnegative(),\n\t\ttokens: z.number().nonnegative()\n\t})).default([])\n});',
    },
  ],
}
