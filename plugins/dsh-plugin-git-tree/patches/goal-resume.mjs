/**
 * Offer to resume a goal that is blocked.
 *
 * A blocked goal is resumable — the goal service lists `blocked` among the phases a
 * `resume` may come from, and the tool contract says so — but the pill only offers
 * the button for `paused`, or for `active` while disarmed:
 *
 *     showResume = goal.phase === "paused" || goal.phase === "active" && activation === "disarmed"
 *
 * `blocked` is simply absent from that list, so the one state a reader most needs a
 * way out of is the one state with no button. Nothing server-side needs to change.
 */
export default {
  id: 'goal-resume',
  summary: 'a blocked goal offers the resume button the service already accepts',
  package: '@deepseek-ai/dsh-client-ui-goal',
  file: 'lib/client.js',
  replacements: [
    {
      find: 'showResume = goal.phase === "paused" || goal.phase === "active" && activation === "disarmed";',
      replace: 'showResume = ["paused", "blocked"].includes(goal.phase) || goal.phase === "active" && activation === "disarmed";',
    },
  ],
}
