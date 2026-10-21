import { describe, expect, it } from 'vitest'
import { renderContextUsage } from '../src/prompt-context.ts'

describe('renderContextUsage', () => {
  it('renders occupancy against the advertised window', () => {
    expect(renderContextUsage({ pressureTokens: 252_175, contextWindow: 1_000_000 }))
      .toBe('Context usage: about 250,000 of the 1,000,000-token context window is in use (25%, about 750,000 tokens free).')
  })

  it('prefers the projected size over the raw provider sample', () => {
    expect(renderContextUsage({ pressureTokens: 500_000, projectedTokens: 100_000, contextWindow: 1_000_000 }))
      .toBe('Context usage: about 100,000 of the 1,000,000-token context window is in use (10%, about 900,000 tokens free).')
  })

  it('reports at least one step of use once any token is in use', () => {
    expect(renderContextUsage({ pressureTokens: 300, contextWindow: 128_000 }))
      .toBe('Context usage: about 6,400 of the 128,000-token context window is in use (5%, about 121,600 tokens free).')
  })

  it('keeps zero use distinct from a missing sample', () => {
    expect(renderContextUsage({ pressureTokens: 0, contextWindow: 128_000 }))
      .toBe('Context usage: about 0 of the 128,000-token context window is in use (0%, about 128,000 tokens free).')
  })

  it('clamps use that reaches or exceeds the window', () => {
    expect(renderContextUsage({ pressureTokens: 1_500_000, contextWindow: 1_000_000 }))
      .toBe('Context usage: about 1,000,000 of the 1,000,000-token context window is in use (100%, about 0 tokens free).')
  })

  it('stays silent until both a sample and a window exist', () => {
    expect(renderContextUsage(undefined)).toBe('')
    expect(renderContextUsage({ contextWindow: 1_000_000 })).toBe('')
    expect(renderContextUsage({ pressureTokens: 252_175 })).toBe('')
  })
})
