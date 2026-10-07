/**
 * The live estimator: instantaneous, decaying, and honest about being idle.
 *
 * No window anywhere, deliberately. A window answers "how fast has this been going"
 * and lags by its own width, which is exactly what makes a rate feel wrong while you
 * are watching it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DECAY_MS, IDLE_RATE, observeBytes, rateLabel } from '../lib/testing/client-liverate.js'

const T = 1_800_000_000_000

test('the first pair of observations gives the immediate speed', () => {
  const first = observeBytes(IDLE_RATE, T, 0)
  assert.equal(first.perSecond, null, 'one observation cannot imply a speed')
  const second = observeBytes(first, T + 100, 1000)
  // 1000 bytes in 100ms.
  assert.equal(Math.round(second.perSecond), 10_000)
})

test('a steady stream settles on the true rate, rather than lagging a window', () => {
  let rate = observeBytes(IDLE_RATE, T, 0)
  for (let index = 1; index <= 40; index += 1) rate = observeBytes(rate, T + index * 100, index * 500)
  // 500 bytes every 100ms is 5000 bytes/s; a real-time figure must be there by now.
  assert.ok(Math.abs(rate.perSecond - 5000) < 60, `expected ~5000, got ${String(rate.perSecond)}`)
})

test('it reacts within a few samples, which is the whole point', () => {
  let rate = observeBytes(IDLE_RATE, T, 0)
  for (let index = 1; index <= 40; index += 1) rate = observeBytes(rate, T + index * 100, index * 500)
  const fast = observeBytes(rate, T + 4100, 40 * 500 + 5000, DECAY_MS)
  // One 50k/s chunk must move the needle immediately, not after a window fills.
  assert.ok(fast.perSecond > 6000, `expected a jump, got ${String(fast.perSecond)}`)
})

test('a stalled stream falls to zero and stays there', () => {
  let rate = observeBytes(IDLE_RATE, T, 0)
  rate = observeBytes(rate, T + 100, 1000)
  for (let index = 1; index <= 12; index += 1) rate = observeBytes(rate, T + 100 + index * 200, 1000)
  assert.equal(rate.perSecond, 0, 'a silent stream must read as zero, not hold its last value')
})

test('a counter that restarts starts again instead of going negative', () => {
  let rate = observeBytes(IDLE_RATE, T, 0)
  rate = observeBytes(rate, T + 1000, 50_000)
  const reset = observeBytes(rate, T + 1100, 20)
  assert.equal(reset.perSecond, null)
  assert.equal(reset.bytes, 20)
})

test('the label is the live figure, and says nothing when nothing is moving', () => {
  const streaming = { bytes: 5000, perSecond: 2048, at: T, movedAt: T }
  assert.equal(rateLabel(streaming), '2.0 kB/s')
  assert.equal(rateLabel({ bytes: 10, perSecond: 300, at: T, movedAt: T }), '300 B/s')
  assert.equal(rateLabel({ bytes: 1 << 22, perSecond: 3 * 1024 * 1024, at: T, movedAt: T }), '3.0 MB/s')
  // A token figure is deliberately not part of this any more: the only one DSH exposes
  // is cumulative and cache-inflated — one step measured 458 output tokens against
  // 594,458 total — and a wrong number is worse than none.
  assert.equal(rateLabel({ bytes: 0, perSecond: null, at: T, movedAt: 0 }), null)
  assert.equal(rateLabel({ bytes: 0, perSecond: 0, at: T, movedAt: 0 }), null)
})
