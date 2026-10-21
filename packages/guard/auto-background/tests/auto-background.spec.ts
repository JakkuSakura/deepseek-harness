/**
 * Behavior coverage for @deepseek-ai/dsh-tool-call-auto-background through the
 * real tool pipeline: a call that outlives its window is replaced by the
 * hand-over result, keeps running as a job, and stops when that job is killed.
 * Timings are deliberately small (a 15 ms window, tools settling after ~120 ms)
 * so the suite observes real wall-clock behavior rather than fake timers.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as autoBackground from '@deepseek-ai/dsh-tool-call-auto-background'
import type { Config } from '@deepseek-ai/dsh-tool-call-auto-background'

/** Small window so the promotion path is reached quickly and deterministically. */
const WINDOW_MS = 15
/** A tool that finishes after this delay always outlives {@link WINDOW_MS}. */
const SLOW_MS = 120

/** Register one live owner for job fencing. */
function registerOwner(ctx: Context, id: string): Agent {
  const sessionId = SessionId(id)
  const agent: Agent = {
    id: sessionId,
    options: {},
    session: Session.create(sessionId, undefined, {
      version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, cwd: process.cwd(), isSeeded: false,
    }),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  return agent
}

/** Mount the tool pipeline, the job registry with its controller, and the plugin. */
async function setup(config: Config = {}): Promise<{ ctx: Context; owner: Agent }> {
  const mounted = await setupWithoutPlugin()
  await mounted.ctx.plugin(autoBackground, {
    backgroundAfterMs: config.backgroundAfterMs ?? WINDOW_MS,
    ...config.include !== undefined ? { include: config.include } : {},
    ...config.exclude !== undefined ? { exclude: config.exclude } : {},
  })
  return mounted
}

/** The same composition without the wrapper, for tests that own its fiber. */
async function setupWithoutPlugin(): Promise<{ ctx: Context; owner: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, { pumpPollMs: 25 })
  await ctx.plugin(ToolJobs)
  return { ctx, owner: registerOwner(ctx, 'auto-background-owner') }
}

/** The composition without the job controller, so an owned registration is refused. */
async function setupWithoutController(): Promise<{ ctx: Context; owner: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, { pumpPollMs: 25 })
  return { ctx, owner: registerOwner(ctx, 'auto-background-owner') }
}

let callCounter = 0
function call(ctx: Context, owner: Agent | undefined, name: string, args: Record<string, unknown> = {}) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`auto-background-${++callCounter}`),
    name,
    arguments: args,
    ...owner === undefined ? {} : { agent: owner },
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function until<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached before timeout')
}

/** A tool whose body settles only after `SLOW_MS`, with the given text. */
const slowTool = (name: string, result = 'slow result') => defineContentToolFixture({
  name,
  description: 'settles after the foreground window',
  parameters: {},
  execute: () => new Promise(resolve => setTimeout(() => {
    resolve([{ type: 'text' as const, text: result }])
  }, SLOW_MS)),
})

/** A tool that observes cancellation and settles on abort instead of waiting. */
const cooperativeTool = defineContentToolFixture({
  name: 'cooperative',
  description: 'settles on abort',
  parameters: {},
  execute: (_args, exec) => new Promise((resolve) => {
    const timer = setTimeout(() => { resolve([{ type: 'text' as const, text: 'finished' }]) }, 5_000)
    exec.signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve([{ type: 'text' as const, text: 'stopped cooperatively' }])
    }, { once: true })
  }),
})

describe('a call inside the window', () => {
  it('returns its own result and registers no job', async () => {
    const { ctx, owner } = await setup()
    ctx.tools.register(defineContentToolFixture({
      name: 'fast', description: 'settles at once', parameters: {},
      execute: async () => [{ type: 'text' as const, text: 'fast result' }],
    }))

    const result = await call(ctx, owner, 'fast')

    expect(text(result)).toBe('fast result')
    expect(ctx.jobs.list(owner.id)).toEqual([])
  })
})

describe('a call that outlives the window', () => {
  it('returns the hand-over result and keeps running as an owned job', async () => {
    const { ctx, owner } = await setup()
    ctx.tools.register(slowTool('slow'))

    const result = await call(ctx, owner, 'slow', { shell: 'ls' })

    expect(result.isError).toBe(false)
    const job = ctx.jobs.list(owner.id)[0]
    expect(job).toBeDefined()
    // The job id is minted per job, so the notice names whichever one this call created.
    expect(text(result)).toBe(
      `[still running after ${WINDOW_MS}ms; moved to background job ${job!.id}]\n`
      + 'The slow call keeps running in the background. You will be notified when it finishes; '
      + 'read its result with job_output, stop it with job_kill.',
    )
    expect(job!.owner).toBe(owner.id)
    expect(job!.label).toBe('slow: {"shell":"ls"}')

    await until(() => ctx.jobs.get(job!.id, owner.id).status === 'completed' ? true : undefined)
    expect(ctx.jobs.readAt(job!.id, 0, owner.id).chunks.map(chunk => chunk.text).join('')).toBe('slow result')
  })

  it('records a failing tool as a failed job carrying its message', async () => {
    const { ctx, owner } = await setup()
    ctx.tools.register(defineContentToolFixture({
      name: 'failing', description: 'rejects after the window', parameters: {},
      execute: async () => {
        await new Promise(resolve => setTimeout(resolve, SLOW_MS))
        throw new Error('boom')
      },
    }))

    const result = await call(ctx, owner, 'failing')
    const job = ctx.jobs.list(owner.id)[0]
    expect(job).toBeDefined()
    expect(text(result)).toContain('moved to background job')

    await until(() => ctx.jobs.get(job!.id, owner.id).status === 'failed' ? true : undefined)
    expect(ctx.jobs.get(job!.id, owner.id).detail).toBe('boom')
    expect(ctx.jobs.readAt(job!.id, 0, owner.id).chunks.map(chunk => chunk.text).join('')).toContain('Error: boom')
  })

  it('stops the call through the job kill and settles killed with its reason', async () => {
    const { ctx, owner } = await setup()
    ctx.tools.register(cooperativeTool)

    const result = await call(ctx, owner, 'cooperative')
    const job = ctx.jobs.list(owner.id)[0]
    expect(text(result)).toContain('moved to background job')
    ctx.jobs.kill(job!.id, owner.id, 'not needed any more')

    await until(() => ctx.jobs.get(job!.id, owner.id).status === 'killed' ? true : undefined)
    expect(ctx.jobs.get(job!.id, owner.id).detail).toContain('not needed any more')
  })

  it('ignores a repeated kill and a kill without a reason', async () => {
    const { ctx, owner } = await setup()
    ctx.tools.register(cooperativeTool)

    await call(ctx, owner, 'cooperative')
    const job = ctx.jobs.list(owner.id)[0]
    expect(ctx.jobs.kill(job!.id, owner.id)).toBe('requested')
    expect(ctx.jobs.kill(job!.id, owner.id)).toBe('requested')

    await until(() => ctx.jobs.get(job!.id, owner.id).status === 'killed' ? true : undefined)
    expect(ctx.jobs.get(job!.id, owner.id).status).toBe('killed')
  })

  it('settles killed with the reason the calling signal aborted with', async () => {
    const { ctx, owner } = await setup()
    ctx.tools.register(cooperativeTool)
    const controller = new AbortController()

    const result = await ctx.tools.execute({
      signal: controller.signal,
      callId: ToolCallId('auto-background-aborted'),
      name: 'cooperative',
      arguments: {},
      agent: owner,
    })
    expect(text(result)).toContain('moved to background job')
    const job = ctx.jobs.list(owner.id)[0]
    controller.abort(new Error('the user stopped the turn'))

    await until(() => ctx.jobs.get(job!.id, owner.id).status === 'killed' ? true : undefined)
    expect(ctx.jobs.get(job!.id, owner.id).detail).toBe('the user stopped the turn')
  })

  it('renders a non-error abort reason as text', async () => {
    const { ctx, owner } = await setup()
    ctx.tools.register(cooperativeTool)
    const controller = new AbortController()

    await ctx.tools.execute({
      signal: controller.signal,
      callId: ToolCallId('auto-background-aborted-text'),
      name: 'cooperative',
      arguments: {},
      agent: owner,
    })
    const job = ctx.jobs.list(owner.id)[0]
    controller.abort('cancelled by policy')

    await until(() => ctx.jobs.get(job!.id, owner.id).status === 'killed' ? true : undefined)
    expect(ctx.jobs.get(job!.id, owner.id).detail).toBe('cancelled by policy')
  })

  it('names non-text content instead of carrying it', async () => {
    const { ctx, owner } = await setup()
    ctx.tools.register(defineContentToolFixture({
      name: 'nontext', description: 'returns a non-text block', parameters: {},
      execute: async () => {
        await new Promise(resolve => setTimeout(resolve, SLOW_MS))
        return [{ type: 'reasoning', text: 'hidden' }]
      },
    }))

    const result = await call(ctx, owner, 'nontext')
    expect(text(result)).toContain('moved to background job')
    const job = ctx.jobs.list(owner.id)[0]
    await until(() => ctx.jobs.get(job!.id, owner.id).status === 'completed' ? true : undefined)
    expect(ctx.jobs.readAt(job!.id, 0, owner.id).chunks.map(chunk => chunk.text).join('')).toBe('[reasoning content is not carried into a background job]')
  })

  it('bounds the argument preview in the job label', async () => {
    const { ctx, owner } = await setup()
    ctx.tools.register(slowTool('slow'))

    await call(ctx, owner, 'slow', { text: 'x'.repeat(400) })
    const job = ctx.jobs.list(owner.id)[0]
    expect(job!.label.length).toBeLessThan(200)
    expect(job!.label.endsWith('…')).toBe(true)
  })

  it('turns a dispatch that fails inside the window into an error result', async () => {
    const { ctx, owner } = await setup({ include: ['instant'] })
    ctx.tools.register(defineContentToolFixture({
      name: 'instant', description: 'settles at once', parameters: {},
      execute: async () => [{ type: 'text' as const, text: 'unused' }],
    }))
    ctx.on('tools/execute', async () => { throw new Error('immediate failure') })

    const result = await call(ctx, owner, 'instant')

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('immediate failure')
    expect(ctx.jobs.list(owner.id)).toEqual([])
  })

  it('reports a dispatch that throws after the window as a failed job with its message', async () => {
    const { ctx, owner } = await setup({ include: ['slow-throw'] })
    ctx.tools.register(defineContentToolFixture({
      name: 'slow-throw', description: 'settles at once', parameters: {},
      execute: async () => [{ type: 'text' as const, text: 'unused' }],
    }))
    // Registered after the plugin, so this wrapper sits inside it and its
    // rejection is what the hand-over job observes.
    ctx.on('tools/execute', async () => {
      await new Promise(resolve => setTimeout(resolve, SLOW_MS))
      throw new Error('thrown failure')
    })

    await call(ctx, owner, 'slow-throw')
    const job = ctx.jobs.list(owner.id)[0]
    await until(() => ctx.jobs.get(job!.id, owner.id).status === 'failed' ? true : undefined)
    expect(ctx.jobs.get(job!.id, owner.id).detail).toBe('thrown failure')
  })

  it('renders a non-error dispatch failure as text', async () => {
    const { ctx, owner } = await setup({ include: ['string-throw'] })
    ctx.tools.register(defineContentToolFixture({
      name: 'string-throw', description: 'settles at once', parameters: {},
      execute: async () => [{ type: 'text' as const, text: 'unused' }],
    }))
    ctx.on('tools/execute', async () => {
      await new Promise(resolve => setTimeout(resolve, SLOW_MS))
      throw 'string failure'
    })

    await call(ctx, owner, 'string-throw')
    const job = ctx.jobs.list(owner.id)[0]
    await until(() => ctx.jobs.get(job!.id, owner.id).status === 'failed' ? true : undefined)
    expect(ctx.jobs.get(job!.id, owner.id).detail).toBe('string failure')
    expect(ctx.jobs.readAt(job!.id, 0, owner.id).chunks.map(chunk => chunk.text).join('')).toContain('string failure')
  })
})

describe('registration refused', () => {
  it('keeps the call in the foreground when no controller can collect the job', async () => {
    const { ctx, owner } = await setupWithoutController()
    await ctx.plugin(autoBackground, { backgroundAfterMs: WINDOW_MS })
    ctx.tools.register(slowTool('slow'))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    const result = await call(ctx, owner, 'slow')

    expect(text(result)).toBe('slow result')
    expect(ctx.jobs.list(owner.id)).toEqual([])
    expect(warn.mock.calls.map(args => String(args[0])).join('\n')).toContain('the job registry refused slow')
    warn.mockRestore()
  })

  it('propagates a dispatch failure that arrives after the refused registration', async () => {
    const { ctx, owner } = await setupWithoutController()
    await ctx.plugin(autoBackground, { backgroundAfterMs: WINDOW_MS, include: ['slow-fail'] })
    ctx.tools.register(defineContentToolFixture({
      name: 'slow-fail', description: 'settles at once', parameters: {},
      execute: async () => [{ type: 'text' as const, text: 'unused' }],
    }))
    ctx.on('tools/execute', async () => {
      await new Promise(resolve => setTimeout(resolve, SLOW_MS))
      throw new Error('failed in the foreground')
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    const result = await call(ctx, owner, 'slow-fail')

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('failed in the foreground')
    warn.mockRestore()
  })
})

describe('the tool scope', () => {
  it('promotes only included tools', async () => {
    const { ctx, owner } = await setup({ include: ['slow'] })
    ctx.tools.register(slowTool('slow'))
    ctx.tools.register(slowTool('other', 'other result'))

    expect(text(await call(ctx, owner, 'slow'))).toContain('moved to background job')
    expect(text(await call(ctx, owner, 'other'))).toBe('other result')
    expect(ctx.jobs.list(owner.id)).toHaveLength(1)
  })

  it('never promotes an excluded tool', async () => {
    const { ctx, owner } = await setup({ exclude: ['slow'] })
    ctx.tools.register(slowTool('slow'))

    expect(text(await call(ctx, owner, 'slow'))).toBe('slow result')
    expect(ctx.jobs.list(owner.id)).toEqual([])
  })

  it('leaves an unowned call in the foreground', async () => {
    const { ctx } = await setup()
    ctx.tools.register(slowTool('slow'))

    const result = await call(ctx, undefined, 'slow')

    expect(text(result)).toBe('slow result')
    expect(ctx.jobs.list()).toEqual([])
  })

  it('never detaches a nested dispatch', async () => {
    const { ctx, owner } = await setup()
    ctx.tools.register(slowTool('slow'))
    let parent: ToolExecutionToken | undefined
    ctx.on('tools/execute', async (exec, next) => {
      if (parent === undefined) parent = exec.token
      return next()
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'outer', description: 'settles at once', parameters: {},
      execute: async () => [{ type: 'text' as const, text: 'outer result' }],
    }))
    await call(ctx, owner, 'outer')

    if (parent === undefined) throw new Error('the outer dispatch did not run')
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('auto-background-nested'),
      name: 'slow',
      arguments: {},
      agent: owner,
      parent,
    })

    expect(text(result)).toBe('slow result')
    expect(ctx.jobs.list(owner.id)).toEqual([])
  })
})

describe('the configuration', () => {
  it('loads without configuration and leaves fast calls untouched', async () => {
    const { ctx, owner } = await setupWithoutPlugin()
    // Direct application exercises the built-in defaults; the Loader fills the
    // same fields from `Config` before calling `apply`.
    autoBackground.apply(ctx)
    ctx.tools.register(defineContentToolFixture({
      name: 'fast', description: 'settles at once', parameters: {},
      execute: async () => [{ type: 'text' as const, text: 'fast result' }],
    }))

    expect(text(await call(ctx, owner, 'fast'))).toBe('fast result')
    expect(ctx.jobs.list(owner.id)).toEqual([])
  })

  it('rejects a non-positive window instead of arming an immediate hand-over', async () => {
    const { ctx } = await setupWithoutPlugin()

    expect(() => { autoBackground.apply(ctx, { backgroundAfterMs: 0 }) }).toThrow(/backgroundAfterMs must be a positive finite number/)
  })
})

describe('lifecycle', () => {
  it('removes the wrapper when its plugin fiber is disposed', async () => {
    const { ctx, owner } = await setupWithoutPlugin()
    ctx.tools.register(slowTool('slow'))

    const fiber = ctx.plugin(autoBackground, { backgroundAfterMs: WINDOW_MS, include: ['slow'] })
    await fiber
    expect(text(await call(ctx, owner, 'slow'))).toContain('moved to background job')
    const promoted = ctx.jobs.list(owner.id)[0]
    await until(() => promoted === undefined || ctx.jobs.get(promoted.id, owner.id).status !== 'running' ? true : undefined)
    ctx.jobs.remove(promoted!.id, owner.id)

    await fiber.dispose()

    expect(text(await call(ctx, owner, 'slow'))).toBe('slow result')
    expect(ctx.jobs.list(owner.id)).toEqual([])
  })
})
