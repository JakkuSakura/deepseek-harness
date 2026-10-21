/**
 * Model-facing verifier instruction, the per-claim request text, and the strict
 * verdict parser for one completion certification.
 * @module @deepseek-ai/dsh-goal-verifier-llm/prompt
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { GoalVerificationVerdict, GoalView } from '@deepseek-ai/dsh-goal'

/** Rendered when the claiming turn recorded no readable evidence. */
const NO_EVIDENCE = '(no recorded evidence)'

/** Case-insensitive prefix the parser removes before reading the verdict word. */
const VERDICT_PREFIX = 'VERDICT:'

/** Case-insensitive prefix the parser removes before reading the reason. */
const REASON_PREFIX = 'REASON:'

/**
 * Stable system instruction for the judge. It states the decision rule, the
 * evidence standard, and the exact reply format the parser enforces.
 */
export const VERIFIER_INSTRUCTION = [
  'You are an independent verifier deciding whether an autonomous agent goal is complete.',
  'Judge only from the goal objective and the recorded session evidence you are given. You did not do the work, and you cannot run commands or read files.',
  '',
  'Rules:',
  '- Answer COMPLETE only when the evidence establishes that every part of the objective is finished, with observed results rather than the agent\'s own claims.',
  '- Answer INCOMPLETE when work remains, when the evidence contradicts the claim, when a result is missing, or when you cannot tell.',
  '- Effort spent, a plan described, or a promise to continue are not evidence of completeness.',
  '',
  'Reply with exactly two lines and nothing else. The first line is `VERDICT: COMPLETE` or `VERDICT: INCOMPLETE`.',
  'The second line is `REASON: <one sentence>` explaining the decision.',
].join('\n')

/**
 * Render the judge's request text for one claim.
 * @param goal - exact goal revision whose completion is claimed.
 * @param evidence - transcript produced by `renderGoalEvidence`.
 * @returns the user-role request text.
 */
export function renderVerificationPrompt(goal: GoalView, evidence: string): string {
  const body = evidence.length === 0 ? NO_EVIDENCE : evidence
  return [
    `Objective: ${JSON.stringify(goal.objective)}`,
    `Autonomous rounds admitted: ${goal.roundsStarted} of ${goal.maxGoalRounds}`,
    '',
    'Recorded session evidence, oldest first:',
    body,
  ].join('\n')
}

/** Extract the model's text output across all returned text blocks. */
function textOutput(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => block.type === 'text' ? block.text : '').join('\n')
}

/**
 * Parse the judge's reply into a verdict.
 * A reply with no recognizable verdict is a refusal: an unusable answer never
 * certifies completion.
 * @param blocks - complete judge output blocks.
 * @returns the parsed verdict; `certified` is false for every unusable reply.
 */
export function parseVerdict(blocks: readonly ContentBlock[]): GoalVerificationVerdict {
  const lines = textOutput(blocks).split('\n').map(line => line.trim())
  const verdictLine = lines.find(line => line.toUpperCase().startsWith(VERDICT_PREFIX))
  if (verdictLine === undefined) {
    return { certified: false, reason: 'the verifier returned no verdict' }
  }
  const reasonLine = lines.find(line => line.toUpperCase().startsWith(REASON_PREFIX))
  const reason = reasonLine === undefined ? '' : reasonLine.slice(REASON_PREFIX.length).trim()
  const verdict = verdictLine.slice(VERDICT_PREFIX.length).trim().toUpperCase()
  if (verdict === 'COMPLETE') {
    return { certified: true, reason: reason.length > 0 ? reason : 'the verifier certified completion' }
  }
  if (verdict === 'INCOMPLETE') {
    return {
      certified: false,
      reason: reason.length > 0 ? reason : 'the verifier reported the objective as incomplete',
    }
  }
  return { certified: false, reason: `the verifier returned an unusable verdict: ${verdictLine}` }
}
