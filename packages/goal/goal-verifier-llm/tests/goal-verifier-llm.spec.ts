import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
  LlmError,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionStore, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { GoalId } from '@deepseek-ai/dsh-goal'
import type { GoalVerificationRequest, GoalView } from '@deepseek-ai/dsh-goal'
import LlmGoalVerifier, {
  parseVerdict,
  renderGoalEvidence,
  renderVerificationPrompt,
  VERIFIER_INSTRUCTION,
} from '@deepseek-ai/dsh-goal-verifier-llm'
import type { Config } from '@deepseek-ai/dsh-goal-verifier-llm'

const PROVIDER = 'judge-provider'
const MODEL = 'judge-model'

const isolatedCtx = new Context()
await isolatedCtx.plugin(SessionStore)

/** Build one live agent over a real session; the verifier reads only its identity. */
function stubAgent(id: string): Agent {
  const session = isolatedCtx.sessions.create(SessionId(id))
  if (isolatedCtx.sessions.get(session.id) !== session) isolatedCtx.sessions.enter(session)
  const inbox = createInboxStub()
  return {
    id: session.id,
    options: {},
    session,
    inbox,
    status: 'running',
    ctx: isolatedCtx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject(input) { this.inbox.append('next-step', input) },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
}

/** One user-role session event carrying the given text. */
function userEvent(text: string, seq: number): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: seq,
    surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  }
}

/** One assistant-role session event carrying the given text. */
function assistantEvent(text: string, seq: number): SessionEvent {
  return {
    type: 'assistant/message',
    seq: SessionSeq(seq),
    time: seq,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { provider: PROVIDER, model: MODEL },
      }),
      stream: [],
    },
  }
}

/** One tool-call/tool-result pair, as the judge sees it. */
function toolEvents(callId: string, name: string, args: string, result: string, seq: number, isError = false): SessionEvent[] {
  return [
    {
      type: 'tool/call',
      seq: SessionSeq(seq),
      time: seq,
      data: { turn: 1, step: 1, callId: ToolCallId(callId), name, arguments: args },
    },
    {
      type: 'tool/result',
      seq: SessionSeq(seq + 1),
      time: seq + 1,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: ToolCallId(callId),
          content: [{ type: 'text', text: result }],
          isError,
        }),
      },
    },
  ]
}

/** A goal view whose completion is being claimed. */
function goalView(objective = 'Ship the migration'): GoalView {
  return {
    id: GoalId('goal-verifier-1'),
    revision: 3,
    objective,
    phase: 'active',
    maxGoalRounds: 5,
    roundsStarted: 2,
    createdAt: 1_000,
    updatedAt: 2_000,
    activation: 'armed',
  }
}

/** A complete claim over an agent and an evidence cut. */
function verificationRequest(agent: Agent, events: readonly SessionEvent[]): GoalVerificationRequest {
  const goal = goalView()
  return { agent, goal, ref: { id: goal.id, revision: goal.revision }, events }
}

/** One streamed text reply ending in `finish`. */
function textReply(text: string, finish: FinishReason = { kind: 'stop' }): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: finish },
  ]
}

/** Adapter that replays one fixed judge reply and records every request. */
class JudgeAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly chunks: readonly StreamChunk[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of this.chunks) yield chunk
  }
}

/** Compose the verifier over a fresh context and a fixed judge reply. */
function harness(chunks: readonly StreamChunk[], config: Config = { provider: PROVIDER, model: MODEL }) {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  const adapter = new JudgeAdapter(chunks)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  const verifier = new LlmGoalVerifier(ctx, config)
  return { ctx, adapter, verifier }
}

describe('goal evidence rendering', () => {
  it('renders one oldest-first transcript of messages and tool activity', () => {
    const events: SessionEvent[] = [
      userEvent('fix the failing gate', 0),
      ...toolEvents('call-1', 'bash', '{"command":"pnpm test"}', '[exit code: 0] result', 1),
      assistantEvent('All gates pass now.', 3),
    ]
    const evidence = renderGoalEvidence(events, 10_000)
    expect(evidence).toBe([
      'USER: fix the failing gate',
      'CALL bash: {"command":"pnpm test"}',
      'RESULT: [exit code: 0] result',
      'ASSISTANT: All gates pass now.',
    ].join('\n'))
  })

  it('marks errored tool results and names non-text blocks', () => {
    const events: SessionEvent[] = [
      ...toolEvents('call-1', 'bash', '{}', 'boom', 0, true),
      {
        type: 'tool/result',
        seq: SessionSeq(2),
        time: 2,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId: ToolCallId('call-2'),
            content: [{ type: 'reasoning', text: 'internal reasoning' }],
            isError: false,
          }),
        },
      },
    ]
    const evidence = renderGoalEvidence(events, 10_000)
    expect(evidence).toContain('ERROR: boom')
    expect(evidence).toContain('[reasoning]')
  })

  it('drops the oldest evidence and names the omission when the marker fits', () => {
    const events: SessionEvent[] = [
      userEvent('earliest request', 0),
      userEvent('later request', 1),
      userEvent('latest request', 2),
    ]
    const evidence = renderGoalEvidence(events, 60)
    expect(evidence.startsWith('[earlier evidence omitted]')).toBe(true)
    expect(evidence).toContain('latest request')
    expect(evidence).not.toContain('earliest request')
    expect(evidence.length).toBeLessThanOrEqual(60)
  })

  it('keeps the newest evidence instead of the marker when the budget is tiny', () => {
    const events: SessionEvent[] = [
      userEvent('earliest request', 0),
      userEvent('later request', 1),
      userEvent('latest request', 2),
    ]
    expect(renderGoalEvidence(events, 30)).toBe('USER: latest request')
  })

  it('keeps the newest tail of one oversized item', () => {
    const evidence = renderGoalEvidence([userEvent('z'.repeat(5_000), 0)], 80)
    expect(evidence).toHaveLength(80)
    expect(evidence.endsWith('chars omitted)')).toBe(true)
  })

  it('clips one oversized item and keeps the transcript inside the budget', () => {
    const events: SessionEvent[] = [userEvent('x'.repeat(5_000), 0)]
    const evidence = renderGoalEvidence(events, 300)
    expect(evidence.length).toBeLessThanOrEqual(300)
    expect(evidence).toContain('chars omitted')
  })

  it('renders nothing for a cut with no readable event', () => {
    expect(renderGoalEvidence([], 1_000)).toBe('')
    expect(renderGoalEvidence([
      {
        type: 'turn/start',
        seq: SessionSeq(0),
        time: 0,
        data: { turn: 1 },
      },
    ], 1_000)).toBe('')
  })
})

describe('goal verdict parsing', () => {
  it('certifies only an explicit COMPLETE verdict', () => {
    expect(parseVerdict([{ type: 'text', text: 'VERDICT: COMPLETE\nREASON: the gates pass' }]))
      .toEqual({ certified: true, reason: 'the gates pass' })
    expect(parseVerdict([{ type: 'text', text: 'VERDICT: INCOMPLETE\nREASON: tests were never run' }]))
      .toEqual({ certified: false, reason: 'tests were never run' })
  })

  it('reads only text blocks out of the judge reply', () => {
    expect(parseVerdict([
      { type: 'reasoning', text: 'VERDICT: INCOMPLETE' },
      { type: 'text', text: 'VERDICT: COMPLETE\nREASON: the transcript shows the gate passing' },
    ])).toEqual({ certified: true, reason: 'the transcript shows the gate passing' })
  })

  it('treats a missing, unusable, or unaccompanied verdict as a refusal', () => {
    expect(parseVerdict([{ type: 'text', text: 'Looks fine to me.' }]))
      .toEqual({ certified: false, reason: 'the verifier returned no verdict' })
    expect(parseVerdict([{ type: 'text', text: 'VERDICT: MAYBE\nREASON: unclear' }]))
      .toEqual({ certified: false, reason: 'the verifier returned an unusable verdict: VERDICT: MAYBE' })
  })

  it('substitutes a default reason when REASON is missing or empty', () => {
    expect(parseVerdict([{ type: 'text', text: 'VERDICT: COMPLETE' }]).reason)
      .toBe('the verifier certified completion')
    expect(parseVerdict([{ type: 'text', text: 'VERDICT: INCOMPLETE\nREASON:   ' }]).reason)
      .toBe('the verifier reported the objective as incomplete')
  })
})

describe('goal verification request text', () => {
  it('states the objective, the round count, and the evidence', () => {
    const text = renderVerificationPrompt(goalView('Ship "the" migration'), 'USER: go')
    expect(text).toContain('Objective: "Ship \\"the\\" migration"')
    expect(text).toContain('Autonomous rounds admitted: 2 of 5')
    expect(text).toContain('USER: go')
  })

  it('names missing evidence instead of sending an empty body', () => {
    expect(renderVerificationPrompt(goalView(), '')).toContain('(no recorded evidence)')
  })
})

describe('goal verifier service', () => {
  it('sends the configured judge request and returns its verdict', async () => {
    const { adapter, verifier } = harness(textReply('VERDICT: COMPLETE\nREASON: verified'))
    const agent = stubAgent('goal-verifier-complete')
    const verdict = await verifier.verify(verificationRequest(agent, [
      userEvent('ship it', 0),
      assistantEvent('done', 1),
    ]))
    expect(verdict).toEqual({ certified: true, reason: 'verified' })
    expect(adapter.requests).toHaveLength(1)
    const request = adapter.requests[0]
    if (request === undefined) throw new Error('expected one judge request')
    expect(request.provider).toBe(PROVIDER)
    expect(request.model).toBe(MODEL)
    expect(request.system).toBe(VERIFIER_INSTRUCTION)
    expect(request.maxTokens).toBe(1024)
    expect(request.sessionId).toBe(agent.session.id)
    const prompt = request.messages[0]?.content[0]
    expect(prompt?.type === 'text' ? prompt.text : '').toContain('USER: ship it')
  })

  it('returns an uncertified verdict for an INCOMPLETE reply', async () => {
    const { verifier } = harness(textReply('VERDICT: INCOMPLETE\nREASON: the gate still fails'))
    const verdict = await verifier.verify(verificationRequest(stubAgent('goal-verifier-incomplete'), []))
    expect(verdict).toEqual({ certified: false, reason: 'the gate still fails' })
  })

  it('rejects when the judge call truncates', async () => {
    const { verifier } = harness(textReply('VERDICT: COMPL', { kind: 'max-tokens' }))
    const failure = await verifier.verify(verificationRequest(stubAgent('goal-verifier-truncated'), []))
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(LlmError)
    expect((failure as LlmError).code).toBe('GOAL_VERIFICATION_TRUNCATED')
  })

  it('rejects when the judge call fails or is aborted', async () => {
    const failureCode = 'GOAL_VERIFICATION_FAILED'
    const { verifier } = harness(textReply('', {
      kind: 'error',
      failure: { message: 'provider down', code: failureCode },
    }))
    const failure = await verifier.verify(verificationRequest(stubAgent('goal-verifier-failed'), []))
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(LlmError)
    expect((failure as LlmError).code).toBe(failureCode)
  })

  it('forwards caller cancellation to the judge request', async () => {
    const { adapter, verifier } = harness(textReply('VERDICT: COMPLETE'))
    const controller = new AbortController()
    const agent = stubAgent('goal-verifier-abort')
    await verifier.verify({ ...verificationRequest(agent, []), signal: controller.signal })
    expect(adapter.requests[0]?.signal).toBe(controller.signal)
  })

  it('fails loud on an unusable configuration', () => {
    const build = (config: Config) => {
      const ctx = new Context()
      void new LlmRuntime(ctx)
      return () => new LlmGoalVerifier(ctx, config)
    }
    expect(build({ provider: ' ', model: MODEL })).toThrow('provider must be a non-empty string')
    expect(build({ provider: PROVIDER, model: '' })).toThrow('model must be a non-empty string')
    expect(build({ provider: PROVIDER, model: MODEL, maxTokens: 0 }))
      .toThrow('maxTokens must be a positive safe integer')
    expect(build({ provider: PROVIDER, model: MODEL, maxEvidenceChars: 1.5 }))
      .toThrow('maxEvidenceChars must be a positive safe integer')
  })
})
