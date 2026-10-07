/**
 * The rolling rate, and the behaviour that matters most: falling to zero when the
 * Session stops. The rate is measured from a counter sampled on a clock, so the
 * tests drive both.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NO_TOKEN_RATE, observeTokens } from '../lib/testing/client-tokrate.js'

/** Feed observations and return the last rate. */
function run(observations) {
  let held = NO_TOKEN_RATE.samples
  let rate = null
  for (const [at, tokens] of observations) {
    const next = observeTokens(held, at, tokens)
    held = next.samples
    rate = next.perSecond
  }
  return { rate, held }
}

test('one sample cannot give a rate, and two that span time can', () => {
  assert.equal(observeTokens([], 1000, 500).perSecond, null)
  // 600 tokens over 2 seconds.
  const { rate } = run([[0, 0], [2000, 600]])
  assert.equal(rate, 300)
})

test('a counter that stops rising pulls the rate towards zero', () => {
  // A burst, then nothing: the same count sampled on a clock, which is what makes
  // the window fill with stillness.
  const { rate } = run([
    [0, 0],
    [1000, 1000],
    [2000, 1000],
    [5000, 1000],
    [10_000, 1000],
  ])
  // 1000 tokens over 10 seconds.
  assert.equal(rate, 100)
})

test('the rate reaches zero once the growth has aged out of the window', () => {
  const { rate } = run([
    [0, 0],
    [1000, 1000],
    // Past the window: the growth is no longer inside it at all.
    [16_000, 1000],
    [17_000, 1000],
  ])
  assert.equal(rate, 0)
})

test('samples older than the window are dropped', () => {
  const { held } = run([[0, 0], [1000, 100], [16_500, 200]])
  assert.ok(held.every(sample => sample.at >= 16_500 - 15_000), 'an old sample survived')
})

test('a counter that goes backwards starts over rather than averaging two runs', () => {
  const { rate, held } = run([[0, 5_000], [1000, 6_000], [2000, 10]])
  // The reset leaves one sample, which cannot give a rate.
  assert.equal(rate, null)
  assert.deepEqual(held.map(sample => sample.tokens), [10])
})

test('an unreadable count still ages the window, at a real cadence', () => {
  // The timer keeps sampling even when the count cannot be read, so the window
  // fills with stillness and the rate falls to zero rather than freezing.
  let held = run([[0, 0], [1000, 1000]]).held
  let rate = null
  for (let at = 2000; at <= 20_000; at += 1000) {
    const next = observeTokens(held, at, null)
    held = next.samples
    rate = next.perSecond
  }
  assert.equal(rate, 0)
})

test('a gap longer than the window leaves nothing to measure', () => {
  // Nothing was observed across the gap, so the honest answer is "cannot say" — the
  // next sample starts over instead of averaging across it.
  const held = run([[0, 0], [1000, 1000]]).held
  assert.equal(observeTokens(held, 20_000, 1000).perSecond, null)
})

test('nothing is recorded for a nonsense count', () => {
  assert.deepEqual(observeTokens([], 0, Number.NaN).samples, [])
  assert.deepEqual(observeTokens([], 0, -1).samples, [])
})
