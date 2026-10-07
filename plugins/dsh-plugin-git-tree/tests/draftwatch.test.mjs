/**
 * Reading unsent input off the composer, which is the only surface that holds it.
 *
 * DSH keeps a draft per Session inside the composer's own model, so a plugin cannot ask
 * another Session for its draft. What it can do is watch the composer and remember what it
 * held, which is what these cover — including the part that keeps the mark honest: an
 * emptied composer forgets a Session, so sending a prompt takes its dot with it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composerText, installDraftWatch } from '../lib/testing/client-draftwatch.js'
import { hasDraft, rememberDraft } from '../lib/testing/client-drafts.js'

/** A document with one composer and a recording observer. */
function fakeDocument(composer) {
  const listeners = []
  return {
    listeners,
    querySelector: () => composer,
    addEventListener: (type, listener) => { listeners.push({ type, listener }) },
    removeEventListener: () => {},
  }
}

test('a textarea and a contenteditable host both report their text', () => {
  assert.equal(composerText({ value: 'hello' }), 'hello')
  assert.equal(composerText({ textContent: 'hello' }), 'hello')
  // A textarea wins when both are somehow present, and an absent composer is empty
  // rather than null, so callers never have to guard the comparison.
  assert.equal(composerText({ value: 'a', textContent: 'b' }), 'a')
  assert.equal(composerText(null), '')
  assert.equal(composerText({}), '')
})

test('the watcher reports on install, on input, and on a mutation', () => {
  const composer = { value: '' }
  const target = fakeDocument(composer)
  const seen = []
  let fire = null
  const dispose = installDraftWatch(target, (text) => { seen.push(text) }, (callback) => {
    fire = callback
    return { observe: () => {}, disconnect: () => {} }
  })
  assert.deepEqual(seen, [''], 'reported the empty composer it found')

  composer.value = 'draft text'
  target.listeners[0].listener()
  assert.equal(seen.at(-1), 'draft text', 'an input event reports the new text')

  // A paste or an attachment can change the composer without an input event.
  composer.value = 'draft text and a file'
  fire()
  assert.equal(seen.at(-1), 'draft text and a file', 'a mutation reports the new text')

  dispose()
})

test('the memory follows the composer, so a sent prompt takes its dot with it', () => {
  let held = rememberDraft(new Map(), 'session-a', 'unsent')
  assert.ok(hasDraft(held, 'session-a'))

  // Sending empties the composer, and the same event that clears it must clear the mark.
  held = rememberDraft(held, 'session-a', '')
  assert.equal(hasDraft(held, 'session-a'), false)

  // Whitespace is not input: a stray space must not claim a Session needs attention.
  held = rememberDraft(held, 'session-b', '   ')
  assert.equal(hasDraft(held, 'session-b'), false)

  // And one Session's draft says nothing about another's.
  held = rememberDraft(held, 'session-c', 'kept')
  assert.deepEqual([...held.keys()], ['session-c'])
})
