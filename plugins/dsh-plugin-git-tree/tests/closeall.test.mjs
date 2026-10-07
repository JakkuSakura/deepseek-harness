/**
 * The close-all walk.
 *
 * The controller lists no tabs, so the only way to close them all is to close the
 * active one repeatedly. These cases pin the three ways that walk has to end: an
 * empty surface, a tab that stays put because its own close refused, and a cap.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { closeEveryTab } from '../lib/testing/client-closeall.js'

/** A surface whose tabs are removed on close, unless the id is pinned. */
function surface(ids, { pinned = [] } = {}) {
  let open = [...ids]
  return {
    closed: [],
    active() {
      const id = open[0]
      return id === undefined ? undefined : { id, kind: 'k', contentId: 'c', title: 't' }
    },
    close(tabId) {
      this.closed.push(String(tabId))
      if (pinned.includes(String(tabId))) return
      open = open.filter(id => id !== String(tabId))
    },
  }
}

test('every tab is closed, in the order they surface', async () => {
  const s = surface(['a', 'b', 'c'])
  const attempted = await closeEveryTab(s)
  assert.deepEqual(attempted, ['a', 'b', 'c'])
  assert.deepEqual(s.closed, ['a', 'b', 'c'])
  assert.equal(s.active(), undefined)
})

test('a tab that refuses to close ends the walk instead of spinning', async () => {
  // The kit's guide: it draws no close control and a programmatic close records
  // nothing, so it stays active and must not be retried forever.
  const s = surface(['a', 'guide', 'b'], { pinned: ['guide'] })
  const attempted = await closeEveryTab(s)
  assert.deepEqual(attempted, ['a', 'guide'])
  assert.equal(s.active().id, 'guide')
})

test('an empty surface closes nothing', async () => {
  const s = surface([])
  assert.deepEqual(await closeEveryTab(s), [])
})

test('a surface that never changes is capped rather than looping forever', async () => {
  let calls = 0
  const s = {
    active: () => ({ id: `tab-${String(calls)}` }),
    close: () => { calls += 1 },
  }
  const attempted = await closeEveryTab(s)
  assert.equal(attempted.length, 64)
  assert.equal(calls, 64)
})
