/**
 * The two behaviours the first version got wrong.
 *
 * It opened each row once and remembered the key, which meant a row React re-collapsed
 * was never opened again. A streaming row re-renders constantly and its disclosure resets,
 * so a running command stayed shut until it had finished — the one moment the output
 * stopped being interesting.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expandClosedRows, installExpandProcessRows } from '../lib/testing/client-expandall.js'

/** A row that reports itself closed and counts how often it is clicked. */
function closedRow(key) {
  return {
    clicks: 0,
    click() { this.clicks += 1 },
    closest(selector) {
      if (selector === '[data-expandable]') return this
      return { getAttribute: name => (name === 'data-chat-call-id' ? key : null) }
    },
    getAttribute: name => (name === 'aria-expanded' ? 'false' : null),
  }
}

/** A document whose transcript always contains the given rows. */
function fakeDocument(rows) {
  const listeners = []
  return {
    listeners,
    body: {},
    querySelectorAll: (selector) => (selector === '[data-chat-flow]'
      ? [{ querySelectorAll: () => rows }]
      : []),
    addEventListener: (type, listener) => { listeners.push({ type, listener }) },
    removeEventListener: () => {},
  }
}

test('a row that re-collapses is opened again, so a running command stays visible', async () => {
  const row = closedRow('call-1')
  const target = fakeDocument([row])
  let fire = null
  installExpandProcessRows(target, (callback) => {
    fire = callback
    return { observe: () => {}, disconnect: () => {} }
  })
  assert.equal(row.clicks, 1, 'the first pass opens it')
  // The observer coalesces passes, so a pass runs a moment after the last change.
  fire()
  await new Promise(resolve => setTimeout(resolve, 250))
  fire()
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.ok(row.clicks >= 3, `expected repeated opens, saw ${row.clicks}`)
})

test('a row the reader closed is left alone, however often it re-renders', async () => {
  const row = closedRow('call-2')
  const target = fakeDocument([row])
  let fire = null
  installExpandProcessRows(target, (callback) => {
    fire = callback
    return { observe: () => {}, disconnect: () => {} }
  })
  const { listener } = target.listeners[0]
  // Reported open at click time, so the reader is shutting it.
  const open = { ...row, getAttribute: name => (name === 'aria-expanded' ? 'true' : null) }
  listener({ target: open })
  const before = row.clicks
  fire()
  await new Promise(resolve => setTimeout(resolve, 250))
  fire()
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(row.clicks, before, 'the reader\u2019s collapse must survive our passes')
})

test('the bookkeeping is the reader\u2019s intent, not a one-shot memory', () => {
  const row = closedRow('call-3')
  const refused = new Set()
  assert.equal(expandClosedRows([row], refused), 1)
  assert.equal(expandClosedRows([row], refused), 1, 'closed again means opened again')
  const closed = new Set(['call-3'])
  assert.equal(expandClosedRows([row], closed), 0, 'but a refused key is skipped')
})
