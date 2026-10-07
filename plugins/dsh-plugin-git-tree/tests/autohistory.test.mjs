/**
 * Pressing the older-history control from a scroll.
 *
 * The chat pages history from that one control and from nothing else, so the
 * behaviour worth pinning is the decision to press it: which offsets ask for a
 * page, and the four ways a press is skipped — a scroll that is not near the head,
 * a port with no control in it, a control already in flight, and an event whose
 * target is not a scrollport at all.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EARLIER_TRIGGER_PX, installAutoHistory, wantsEarlierPage } from '../lib/testing/client-autohistory.js'

/** A document that hands back the listeners it was given, so a case can fire one. */
function fakeDocument() {
  const listeners = new Set()
  return {
    added: 0,
    removed: 0,
    fire(event) {
      for (const listener of [...listeners]) listener(event)
    },
    addEventListener(_type, listener) { listeners.add(listener); this.added += 1 },
    removeEventListener(_type, listener) { listeners.delete(listener); this.removed += 1 },
  }
}

/** A scrollport whose head holds a pressable control. */
function fakePort(scrollTop, { disabled = false, control = true } = {}) {
  const button = {
    disabled,
    presses: 0,
    click() { this.presses += 1 },
  }
  const wrapper = { querySelector: () => button }
  return {
    button,
    port: {
      scrollTop,
      querySelector: (selector) => (selector === "[class*='_older']" && control ? wrapper : null),
    },
  }
}

test('a page is asked for within the threshold, and not above it', () => {
  assert.equal(wantsEarlierPage(0), true)
  assert.equal(wantsEarlierPage(EARLIER_TRIGGER_PX), true)
  assert.equal(wantsEarlierPage(EARLIER_TRIGGER_PX + 1), false)
  assert.equal(wantsEarlierPage(4000), false)
  assert.equal(wantsEarlierPage(0, 0), true)
})

test('reaching the head presses the control', () => {
  const document = fakeDocument()
  installAutoHistory(document)
  const { button, port } = fakePort(12)
  document.fire({ target: port })
  assert.equal(button.presses, 1)
})

test('a scroll that is not near the head presses nothing', () => {
  const document = fakeDocument()
  installAutoHistory(document)
  const { button, port } = fakePort(2500)
  document.fire({ target: port })
  assert.equal(button.presses, 0)
})

test('no control means no history to ask for', () => {
  const document = fakeDocument()
  installAutoHistory(document)
  const { button, port } = fakePort(5, { control: false })
  document.fire({ target: port })
  assert.equal(button.presses, 0)
})

test('a control already in flight is left alone', () => {
  const document = fakeDocument()
  installAutoHistory(document)
  const { button, port } = fakePort(5, { disabled: true })
  document.fire({ target: port })
  assert.equal(button.presses, 0)
})

test('a target that is not a scrollport is ignored', () => {
  const document = fakeDocument()
  installAutoHistory(document)
  assert.doesNotThrow(() => {
    document.fire({ target: null })
    document.fire({ target: {} })
    document.fire({ target: 7 })
  })
})

test('the listener is captured, and disposed with the plugin', () => {
  const document = fakeDocument()
  const dispose = installAutoHistory(document)
  assert.equal(document.added, 1)
  dispose()
  assert.equal(document.removed, 1)
  const { button, port } = fakePort(1)
  document.fire({ target: port })
  assert.equal(button.presses, 0)
})
