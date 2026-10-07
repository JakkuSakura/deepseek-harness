/**
 * Opening the process rows.
 *
 * The rows carry their own disclosure and start collapsed; no mode or setting
 * opens them. What matters is that a row React re-collapses is opened again — a
 * streaming row resets its own disclosure on every render — while a row the *reader*
 * collapsed is left alone. The old rule was "open once, ever", which kept a running
 * command shut until it had finished.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expandClosedRows, installExpandProcessRows, rowKey } from '../lib/testing/client-expandall.js'

/** A row whose ancestors carry the identity attributes. */
function fakeRow(attributes, { clicks = [] } = {}) {
  return {
    clicks,
    click() { this.clicks.push(this) },
    closest: () => ({ getAttribute: name => attributes[name] ?? null }),
  }
}

test('a tool row is named by its call id', () => {
  assert.equal(rowKey(fakeRow({ 'data-chat-call-id': 'call-7' })), 'call-7')
})

test('any other row is named by its node key and group part', () => {
  const row = fakeRow({ 'data-chat-node-key': '14:assistant-step1:1', 'data-chat-group-part': 'reasoning' })
  assert.equal(rowKey(row), '14:assistant-step1:1:reasoning')
})

test('a row with no identity is left alone rather than opened under a shared name', () => {
  assert.equal(rowKey(fakeRow({})), null)
  const clicks = []
  const opened = new Set()
  assert.equal(expandClosedRows([fakeRow({}, { clicks })], opened), 0)
  assert.equal(clicks.length, 0)
})

test('every closed row is opened once', () => {
  const clicks = []
  const rows = [
    fakeRow({ 'data-chat-call-id': 'a' }, { clicks }),
    fakeRow({ 'data-chat-call-id': 'b' }, { clicks }),
  ]
  const refused = new Set()
  assert.equal(expandClosedRows(rows, refused), 2)
  assert.equal(clicks.length, 2)
  // Seen again and still closed, they are opened again: that is a row whose disclosure
  // React reset, which is what happens on every render while a command is running.
  assert.equal(expandClosedRows(rows, refused), 2)
  assert.equal(clicks.length, 4)
  // A key the reader refused is skipped, so their collapse survives.
  assert.equal(expandClosedRows(rows, new Set(['a', 'b'])), 0)
  assert.equal(clicks.length, 4)
})

test('a row appearing later is still opened', () => {
  const clicks = []
  const opened = new Set()
  expandClosedRows([fakeRow({ 'data-chat-call-id': 'a' }, { clicks })], opened)
  assert.equal(expandClosedRows([fakeRow({ 'data-chat-call-id': 'b' }, { clicks })], opened), 1)
  assert.equal(clicks.length, 2)
})

test('the watcher opens what is already there, and coalesces what arrives', async () => {
  const clicks = []
  const rows = [fakeRow({ 'data-chat-call-id': 'a' }, { clicks })]
  let notify = () => {}
  const document = {
    body: {},
    querySelectorAll: (selector) => (selector === '[data-chat-flow]' ? [{
      querySelectorAll: (inner) => (inner.startsWith('[data-expandable]') ? rows : []),
    }] : []),
  }
  const observer = {
    observe: () => {},
    disconnect: () => { notify = () => {} },
  }
  const dispose = installExpandProcessRows(document, callback => { notify = callback; return observer })
  assert.equal(clicks.length, 1)

  rows.push(fakeRow({ 'data-chat-call-id': 'b' }, { clicks }))
  notify()
  await new Promise(resolve => setTimeout(resolve, 300))
  // Both rows, because the first is still closed in this double — the fake rows never
  // actually open, so every pass finds them closed. That is the point of the new rule.
  assert.equal(clicks.length, 3)

  dispose()
  rows.push(fakeRow({ 'data-chat-call-id': 'c' }, { clicks }))
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(clicks.length, 3)
})
