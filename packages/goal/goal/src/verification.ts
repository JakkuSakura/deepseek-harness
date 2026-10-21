/**
 * Completion-certification extension point of the goal domain: the request, the
 * verdict, and the optional `ctx.goalVerifier` service a policy plugin
 * implements. The domain itself never evaluates an objective; a mounted
 * verifier decides whether an autonomous completion claim is certified.
 * @module @deepseek-ai/dsh-goal/verification
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { GoalRef, GoalView } from './types.ts'

/**
 * One autonomous completion claim awaiting certification.
 *
 * `events` is the immutable session cut the claiming caller already holds; the
 * verifier renders evidence from it instead of reading session history, so a
 * claim and the evidence it rests on describe the same instant.
 */
export interface GoalVerificationRequest {
  /** Owning live agent whose session logged the claim. */
  readonly agent: Agent
  /** Exact goal revision the claim cites, as returned by `ctx.goals.get()`. */
  readonly goal: GoalView
  /** Compare-and-set identity of the claimed revision. */
  readonly ref: GoalRef
  /** Immutable session event cut taken by the claiming caller. */
  readonly events: readonly SessionEvent[]
  /** Cancellation for the verification work. */
  readonly signal?: AbortSignal
}

/**
 * Outcome of one certification attempt. A refusal names why, because the
 * reason reaches the model as the failed tool call's message.
 */
export interface GoalVerificationVerdict {
  /** Whether the evidence establishes completion of the whole objective. */
  readonly certified: boolean
  /** One-sentence justification, or the refusal reason. */
  readonly reason: string
}

/**
 * Completion-certification service. A composition mounts at most one verifier;
 * `update_goal` consults it before recording an autonomous completion claim.
 */
export interface GoalVerifierService {
  /**
   * Certify or refuse one autonomous completion claim.
   * @param request - exact goal revision, immutable evidence cut, and cancellation.
   * @returns the certification verdict; refusals keep the goal active.
   * @throws when verification itself fails (provider error, unusable response);
   * callers must treat that as a refusal rather than as certification.
   */
  verify(request: GoalVerificationRequest): Promise<GoalVerificationVerdict>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    goalVerifier: GoalVerifierService
  }
}
