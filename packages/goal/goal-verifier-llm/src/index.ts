/**
 * Independent LLM judge that certifies autonomous goal completion claims: the
 * `ctx.goalVerifier` provider for the goal domain's certification extension
 * point.
 * @module @deepseek-ai/dsh-goal-verifier-llm
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type {
  GoalVerificationRequest,
  GoalVerificationVerdict,
  GoalVerifierService,
} from '@deepseek-ai/dsh-goal'
import { renderGoalEvidence } from './evidence.ts'
import { parseVerdict, renderVerificationPrompt, VERIFIER_INSTRUCTION } from './prompt.ts'

export { renderGoalEvidence } from './evidence.ts'
export { parseVerdict, renderVerificationPrompt, VERIFIER_INSTRUCTION } from './prompt.ts'

/** Deployment choices for the judging provider and its request bounds. */
export interface Config {
  /** Registered provider route the judge call uses. */
  provider: string
  /** Exact model id the judge call uses. */
  model: string
  /** Output-token cap for one judge reply. */
  maxTokens?: number
  /** Maximum evidence characters sent to the judge. */
  maxEvidenceChars?: number
}

/** Schemastery config for the judging provider. */
export const Config: z<Config> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  maxTokens: z.number().step(1).min(1).default(1024),
  maxEvidenceChars: z.number().step(1).min(1).default(20_000),
})

/** Fully materialized judging configuration. */
interface ResolvedConfig {
  readonly provider: string
  readonly model: string
  readonly maxTokens: number
  readonly maxEvidenceChars: number
}

/**
 * Validate one configuration, including direct `apply` calls outside Loader
 * normalization, so a misconfigured verifier fails at load rather than on the
 * first completion claim.
 * @param config - raw deployment configuration.
 * @returns the materialized configuration.
 */
function resolveConfig(config: Config): ResolvedConfig {
  const provider = config.provider.trim()
  const model = config.model.trim()
  if (provider.length === 0) throw new TypeError('goal-verifier-llm: provider must be a non-empty string')
  if (model.length === 0) throw new TypeError('goal-verifier-llm: model must be a non-empty string')
  const maxTokens = config.maxTokens ?? 1024
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new TypeError('goal-verifier-llm: maxTokens must be a positive safe integer')
  }
  const maxEvidenceChars = config.maxEvidenceChars ?? 20_000
  if (!Number.isSafeInteger(maxEvidenceChars) || maxEvidenceChars < 1) {
    throw new TypeError('goal-verifier-llm: maxEvidenceChars must be a positive safe integer')
  }
  return { provider, model, maxTokens, maxEvidenceChars }
}

/** Independent LLM judge over one completion claim's recorded evidence. */
export default class LlmGoalVerifier extends Service implements GoalVerifierService {
  static inject = ['llm']

  static Config: z<Config> = Config

  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - context providing the LLM seam.
   * @param config - provider route, model, and request bounds.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'goalVerifier')
    this.resolved = resolveConfig(config)
  }

  /**
   * Ask the configured model to certify one autonomous completion claim.
   * A truncated, aborted, or failed judge call rejects: the caller must treat
   * an unverifiable claim as uncertified while reporting the failure.
   * @param request - exact goal revision, evidence cut, and cancellation.
   * @returns the parsed verdict.
   * @throws {LlmError} when the judge call fails, is cancelled, or truncates.
   */
  async verify(request: GoalVerificationRequest): Promise<GoalVerificationVerdict> {
    const evidence = renderGoalEvidence(request.events, this.resolved.maxEvidenceChars)
    const messages: RequestMessage[] = [{
      role: 'user',
      content: [{ type: 'text', text: renderVerificationPrompt(request.goal, evidence) }],
    }]
    const options: GenerateOptions = {
      provider: this.resolved.provider,
      model: this.resolved.model,
      system: VERIFIER_INSTRUCTION,
      messages,
      maxTokens: this.resolved.maxTokens,
      sessionId: request.agent.session.id,
      ...request.signal === undefined ? {} : { signal: request.signal },
    }
    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
    const finish = assembler.finish
    switch (finish.kind) {
      case 'error':
      case 'aborted':
        throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
      case 'max-tokens':
        throw new LlmError(
          'goal verification output was truncated at the token cap',
          'GOAL_VERIFICATION_TRUNCATED',
        )
      default:
        return parseVerdict(assembler.blocks())
    }
  }
}
