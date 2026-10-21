import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

/** Mount the production prompt registry, session projections, and token meter around one real Agent. */
async function mounted(): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, agent: await harness.create(SessionId('token-usage-context')) }
}

/** Read the model-facing occupancy contribution, or `undefined` when none renders. */
async function usageText(ctx: Context, agent?: Agent): Promise<string | undefined> {
  const assembly = await ctx.systemPrompt.assemble(agent === undefined ? {} : { agent })
  const text = assembly.contexts.find(context => context.name === 'token:usage')?.text
  return text === undefined || text === '' ? undefined : text
}

/** Append one durable usage sample the pressure projection anchors on. */
function sampleUsage(agent: Agent, usage: TokenUsage): void {
  agent.session.append('assistant/attempt', {
    turn: 1,
    step: 1,
    stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }],
  })
}

const WINDOW = 1_000_000

describe('token:usage runtime context', () => {
  it('publishes measured occupancy against the advertised window', async () => {
    const { ctx, agent } = await mounted()
    expect(await usageText(ctx, agent)).toBeUndefined()

    agent.session.append('request/context', { provider: 'mock', model: 'mock', contextWindow: WINDOW })
    expect(await usageText(ctx, agent)).toBeUndefined()

    sampleUsage(agent, { inputTokens: 1_000, outputTokens: 700, cacheReadTokens: 249_000, cacheWriteTokens: 0 })
    expect(await usageText(ctx, agent))
      .toBe('Context usage: about 250,000 of the 1,000,000-token context window is in use (25%, about 750,000 tokens free).')
  })

  it('changes only when occupancy crosses a reported step', async () => {
    const { ctx, agent } = await mounted()
    agent.session.append('request/context', { provider: 'mock', model: 'mock', contextWindow: WINDOW })
    sampleUsage(agent, { inputTokens: 200_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(await usageText(ctx, agent)).toContain('(20%, about 800,000 tokens free)')

    sampleUsage(agent, { inputTokens: 202_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(await usageText(ctx, agent)).toContain('(20%, about 800,000 tokens free)')

    sampleUsage(agent, { inputTokens: 235_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(await usageText(ctx, agent)).toContain('(25%, about 750,000 tokens free)')
  })

  it('stays out of agentless assemblies', async () => {
    const { ctx, agent } = await mounted()
    agent.session.append('request/context', { provider: 'mock', model: 'mock', contextWindow: WINDOW })
    sampleUsage(agent, { inputTokens: 200_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(await usageText(ctx)).toBeUndefined()
  })
})
