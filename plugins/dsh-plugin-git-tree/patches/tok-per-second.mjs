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
 */
export default {
  id: 'tok-per-second',
  summary: 'composer tok/s becomes a 15-second window instead of a lifetime average',
  package: '@deepseek-ai/dsh-session-stats',
  file: 'lib/index.js',
  replacements: [
    {
      // The fold's initial state gains the window's contents. The anchor spans two
      // lines so that it is not a prefix of its own replacement: a find string like
      // that matches after being applied, which is how a copy got patched twice.
      find: '\t\tdecodeMs: 0,\n\t\tdecodeTokens: 0,',
      replace: '\t\tdecodeMs: 0,\n\t\tdecodeSteps: [],\n\t\tdecodeTokens: 0,',
    },
    {
      // Each finished step is kept, the window is applied, and the scalars follow it.
      find: `\t\t\t\t\t\tnext.decodeMs += Math.max(0, event.time - firstToken);
\t\t\t\t\t\tnext.decodeTokens += outputTokens;`,
      replace: `\t\t\t\t\t\tnext.decodeSteps.push({
\t\t\t\t\t\t\ttime: event.time,
\t\t\t\t\t\t\tms: Math.max(0, event.time - firstToken),
\t\t\t\t\t\t\ttokens: outputTokens
\t\t\t\t\t\t});
\t\t\t\t\t\tconst windowStart = event.time - 15000;
\t\t\t\t\t\tnext.decodeSteps = next.decodeSteps.filter((step) => step.time >= windowStart);
\t\t\t\t\t\tnext.decodeMs = next.decodeSteps.reduce((total, step) => total + step.ms, 0);
\t\t\t\t\t\tnext.decodeTokens = next.decodeSteps.reduce((total, step) => total + step.tokens, 0);`,
    },
  ],
}
