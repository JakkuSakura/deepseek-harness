/**
 * The pill override's decision-making, which is the part worth pinning: what counts
 * as DSH's rate figure, and what this replaces it with.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isRateText, rateText } from '../lib/testing/client-pillrate.js'

test('the rate figure is recognised, and nothing else is', () => {
  assert.equal(isRateText('224 tok/s'), true)
  assert.equal(isRateText(' 12.5 tok/s '), true)
  assert.equal(isRateText('1,024 tok/s'), true)
  // The neighbouring figures in the same pill must not be touched.
  assert.equal(isRateText('267 turns'), false)
  assert.equal(isRateText('2816 steps'), false)
  assert.equal(isRateText('tok/s'), false)
  assert.equal(isRateText('224 tok/s extra'), false)
})

test('the replacement is the live stream figure, and nothing when it is quiet', () => {
  // Nothing observed yet: leave the pill alone rather than write a placeholder.
  assert.equal(rateText(), null)
})


