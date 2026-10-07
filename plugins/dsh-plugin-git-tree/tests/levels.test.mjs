/**
 * The comparison the poll leans on.
 *
 * Every open directory is re-listed once a second, and each read arrives as new
 * arrays of new objects. This is what lets an unchanged read keep the state it
 * replaces, so the tree does not re-render — and does not flash a placeholder —
 * on a tick that found nothing.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sameLevel } from '../lib/testing/client-levels.js'

const file = (name, size) => ({ name, type: 'file', size })
const dir = name => ({ name, type: 'directory' })

test('two reads of an unchanged directory are interchangeable', () => {
  const held = { kind: 'ready', entries: [dir('src'), file('a.ts', 10)], truncated: false }
  // Fresh objects, as a second read would produce.
  const read = { kind: 'ready', entries: [dir('src'), file('a.ts', 10)], truncated: false }
  assert.equal(sameLevel(held, read), true)
})

test('a different directory state is not interchangeable', () => {
  const held = { kind: 'ready', entries: [file('a.ts', 10)], truncated: false }
  const cases = {
    'an added entry': { kind: 'ready', entries: [file('a.ts', 10), file('b.ts', 3)], truncated: false },
    'a removed entry': { kind: 'ready', entries: [], truncated: false },
    'a reordered entry': { kind: 'ready', entries: [file('b.ts', 3), file('a.ts', 10)], truncated: false },
    'a changed size': { kind: 'ready', entries: [file('a.ts', 11)], truncated: false },
    'a changed type': { kind: 'ready', entries: [{ name: 'a.ts', type: 'directory' }], truncated: false },
    'a changed truncation': { kind: 'ready', entries: [file('a.ts', 10)], truncated: true },
  }
  for (const [label, read] of Object.entries(cases)) {
    assert.equal(sameLevel(held, read), false, label)
  }
})

test('a kind change is never interchangeable', () => {
  const ready = { kind: 'ready', entries: [], truncated: false }
  assert.equal(sameLevel(ready, { kind: 'loading' }), false)
  assert.equal(sameLevel({ kind: 'loading' }, ready), false)
  assert.equal(sameLevel(undefined, ready), false)
  assert.equal(sameLevel({ kind: 'loading' }, { kind: 'loading' }), true)
})

test('a failure repeats only when it says the same thing', () => {
  const held = { kind: 'failed', code: 'EACCES', message: 'permission denied' }
  assert.equal(sameLevel(held, { kind: 'failed', code: 'EACCES', message: 'permission denied' }), true)
  assert.equal(sameLevel(held, { kind: 'failed', code: 'ENOENT', message: 'permission denied' }), false)
  assert.equal(sameLevel(held, { kind: 'failed', code: 'EACCES', message: 'gone' }), false)
  assert.equal(sameLevel(held, { kind: 'ready', entries: [], truncated: false }), false)
})
