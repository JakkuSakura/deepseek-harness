/**
 * The notification rules.
 *
 * The recency guard is the load-bearing one: the Host sees events through a fold
 * that is replayed over the whole log, so without it every restart would announce
 * every historical turn.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RECENT_MS, isFailure, noticeForEvent, noticeKey } from '../lib/testing/trigger.js'

const NOW = 1_800_000_000_000

test('a turn that just ended is finished', () => {
  const event = { type: 'turn/end', time: NOW - 1000, data: { turn: 4 } }
  assert.deepEqual(noticeForEvent(event, 's1', NOW), { trigger: 'finished', sessionId: 's1' })
})

test('history is never announced, however loud it was', () => {
  // This is what makes a replayed fold safe.
  assert.equal(noticeForEvent({ type: 'turn/end', time: NOW - RECENT_MS - 1 }, 's1', NOW), null)
  assert.equal(noticeForEvent({ type: 'turn/end' }, 's1', NOW), null, 'no time cannot be recent')
  assert.equal(noticeForEvent({ type: 'turn/end', time: Number.NaN }, 's1', NOW), null)
})

test('only the turn is announced, not every mistake inside it', () => {
  // A failed tool call is part of working — agents retry — and announcing those
  // would make the notifier noise.
  assert.equal(noticeForEvent({ type: 'tool/result', time: NOW }, 's1', NOW), null)
  assert.equal(noticeForEvent({ type: 'step/end', time: NOW }, 's1', NOW), null)
  assert.equal(noticeForEvent({ type: 'turn/start', time: NOW }, 's1', NOW), null)
  assert.equal(noticeForEvent({ type: 'assistant/message', time: NOW }, 's1', NOW), null)
})

test('a turn that failed is reported as a failure', () => {
  for (const data of [{ error: true }, { error: 'provider refused' }, { status: 'error' }, { status: 'aborted' }, { failure: { code: 'x' } }]) {
    assert.equal(noticeForEvent({ type: 'turn/end', time: NOW, data }, 's1', NOW).trigger, 'error', JSON.stringify(data))
  }
  // A healthy turn must not be misread as broken.
  for (const data of [{ status: 'ok' }, { status: 'success' }, { error: '' }, { turn: 3 }]) {
    assert.equal(noticeForEvent({ type: 'turn/end', time: NOW, data }, 's1', NOW).trigger, 'finished', JSON.stringify(data))
  }
  assert.equal(isFailure({ type: 'turn/end' }), false)
})

test('the same event produces the same key, so a replayed fold is silent', () => {
  const event = { type: 'turn/end', time: NOW }
  const notice = noticeForEvent(event, 's1', NOW)
  assert.equal(noticeKey(notice, event), noticeKey(notice, event))
  assert.notEqual(noticeKey(notice, { ...event, time: NOW + 1 }), noticeKey(notice, event))
})
