/**
 * Who gets told, and how often.
 *
 * The rule that matters is "only on the transition": a Session that is already
 * waiting must not re-notify on every mutation, or a reader who steps away gets the
 * same message every few seconds until they come back.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  readStatusRows, rememberStatuses, waitingTransitions,
} from '../lib/testing/client-notify.js'

const row = (id, status, title) => ({ id, status, ...(title === undefined ? {} : { title }) })

test('only a Session that has just started waiting is reported', () => {
  const before = rememberStatuses([row('a', 'running'), row('b', 'none')])
  const after = [row('a', 'input', 'FerroPhase'), row('b', 'none')]
  assert.deepEqual(waitingTransitions(before, after), [{ sessionId: 'a', title: 'FerroPhase' }])
})

test('a Session already waiting is not reported again', () => {
  const waiting = rememberStatuses([row('a', 'input')])
  assert.deepEqual(waitingTransitions(waiting, [row('a', 'input')]), [])
})

test('nothing else is a reason to interrupt anyone', () => {
  const idle = rememberStatuses([row('a', 'none'), row('b', 'none'), row('c', 'none')])
  const after = [row('a', 'running'), row('b', 'unread'), row('c', 'none')]
  assert.deepEqual(waitingTransitions(idle, after), [])
})

test('leaving and re-entering waiting reports again, because it is new', () => {
  const left = rememberStatuses([row('a', 'running')])
  assert.equal(waitingTransitions(left, [row('a', 'input')]).length, 1)
  const back = rememberStatuses([row('a', 'input')])
  assert.deepEqual(waitingTransitions(back, [row('a', 'input')]), [])
  // Answered and waiting again is a second thing to say.
  const answered = rememberStatuses([row('a', 'running')])
  assert.equal(waitingTransitions(answered, [row('a', 'input')]).length, 1)
})

test('the panel rows are read from the markup it draws', () => {
  const nodes = [
    { getAttribute: (name) => ({ 'data-session-id': 's1', 'data-session-status': 'input', 'data-session-title': 'FerroPhase' })[name] ?? null },
    { getAttribute: (name) => ({ 'data-session-id': 's2', 'data-session-status': 'running' })[name] ?? null },
    { getAttribute: () => null },
  ]
  const root = { querySelectorAll: () => nodes }
  assert.deepEqual(readStatusRows(root), [
    { id: 's1', status: 'input', title: 'FerroPhase' },
    { id: 's2', status: 'running' },
  ])
})
