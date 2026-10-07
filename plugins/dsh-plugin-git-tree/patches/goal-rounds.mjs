/**
 * Let a human resume a goal that has used up its round budget.
 *
 * The engine refuses, and its refusal asks for something the reader cannot do:
 *
 *     goal "…" exhausted 256 goal rounds; increase maxGoalRounds before resuming
 *
 * Nothing in the UI edits `maxGoalRounds`, and `resume` is explicitly forbidden from
 * changing it — `requireSameDefinition` rejects any change to the objective *or* the
 * budget, on every operation. So an exhausted goal could not be continued by anyone.
 *
 * Resuming is a human decision, so the budget moves instead of the counter: the counter
 * is what the round numbering validates against, and changing it would make the next
 * round inadmissible. A resume may therefore raise the budget and never lower it.
 */
export default {
  id: 'goal-rounds',
  summary: 'resuming an exhausted goal grants another 256 rounds instead of refusing',
  package: '@deepseek-ai/dsh-goal',
  file: 'lib/index.js',
  replacements: [
    {
      find: '\tif (next.objective !== current.objective || next.maxGoalRounds !== current.maxGoalRounds) throw new Error(`goal ${operation} cannot change objective or maxGoalRounds`);',
      replace: '\tif (next.objective !== current.objective || (next.maxGoalRounds !== current.maxGoalRounds && !(operation === "resume" && next.maxGoalRounds > current.maxGoalRounds))) throw new Error(`goal ${operation} cannot change objective or maxGoalRounds`);',
    },
    {
      find: '\t\t\tif (currentState.roundsStarted >= current.maxGoalRounds) throw new GoalError(`goal "${current.id}" exhausted ${current.maxGoalRounds} goal rounds; increase maxGoalRounds before resuming`, "GOAL_INVALID_TRANSITION");\n\t\t\treturn this.commitCurrent(agent, currentState, runtime, "resume", this.withPhase(current, "active"), "armed");',
      replace: '\t\t\t// An exhausted budget is a human decision, not a dead end. A reader who clicks\n\t\t\t// continue is granting more room, and refusing them left the goal unresumable with\n\t\t\t// advice they had no way to act on: nothing in the UI edits maxGoalRounds, and\n\t\t\t// `resume` was itself forbidden from changing it.\n\t\t\t//\n\t\t\t// The counter is deliberately left alone — the round numbering validates against it\n\t\t\t// — so the budget moves instead of the count.\n\t\t\tif (currentState.roundsStarted >= current.maxGoalRounds) {\n\t\t\t\treturn this.commitCurrent(agent, currentState, runtime, "resume", {\n\t\t\t\t\t...this.withPhase(current, "active"),\n\t\t\t\t\tmaxGoalRounds: current.maxGoalRounds + 256\n\t\t\t\t}, "armed");\n\t\t\t}\n\t\t\treturn this.commitCurrent(agent, currentState, runtime, "resume", this.withPhase(current, "active"), "armed");',
    },
  ],
}
