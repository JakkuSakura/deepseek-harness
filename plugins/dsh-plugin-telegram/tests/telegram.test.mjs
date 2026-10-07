/**
 * The rules the bridge rests on, tested without a bot, a token or a network — which
 * is the point of keeping them out of the code that talks to Telegram.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MESSAGE_LIMIT, chunks, isAllowed, nextOffset, parseUpdate, retryDelayMs,
} from '../lib/testing/telegram.js'

const text = (overrides = {}) => ({
  update_id: 7,
  message: {
    message_id: 11,
    chat: { id: 42 },
    from: { id: 99 },
    text: 'run the tests',
    ...overrides,
  },
})

test('a plain text message is bridged', () => {
  const parsed = parseUpdate(text())
  assert.equal(parsed.updateId, 7)
  assert.deepEqual(parsed.message, { chatId: '42', userId: '99', messageId: 11, text: 'run the tests' })
})

test('anything that is not a text message is dropped, not guessed at', () => {
  // A photo, a sticker, an edit, a keyboard callback: none of them is a task.
  assert.equal(parseUpdate({ update_id: 1, message: { message_id: 2, chat: { id: 1 }, from: { id: 1 } } }), null)
  assert.equal(parseUpdate({ update_id: 1, message: { message_id: 2, chat: { id: 1 }, from: { id: 1 }, text: '   ' } }), null)
  assert.equal(parseUpdate({ update_id: 1, edited_message: { text: 'x' } }), null)
  assert.equal(parseUpdate({ update_id: 1, callback_query: { data: 'x' } }), null)
  assert.equal(parseUpdate({ update_id: 'seven', message: { text: 'x' } }), null)
  assert.equal(parseUpdate(null), null)
})

test('the allow-list fails closed', () => {
  const message = { chatId: '42', userId: '99', messageId: 1, text: 'x' }
  // An empty list is nobody, not everybody: a message here can run tools on this
  // machine, so the default has to be closed.
  assert.equal(isAllowed(message, [], []), false)
  assert.equal(isAllowed(message, ['42'], []), false)
  assert.equal(isAllowed(message, [], ['99']), false)
  assert.equal(isAllowed(message, ['42'], ['99']), true)
  // Both have to agree.
  assert.equal(isAllowed(message, ['42'], ['100']), false)
  assert.equal(isAllowed(message, ['43'], ['99']), false)
})

test('the offset advances past the highest id, not the last one', () => {
  // Telegram redelivers everything at or after the offset, so a batch that arrives
  // out of order must not move it backwards.
  assert.equal(nextOffset([5, 9, 7], 5), 10)
  assert.equal(nextOffset([], 10), 10)
  assert.equal(nextOffset([3, 4], 0), 5)
})

test('a long reply is split without losing a character', () => {
  const long = `${'a'.repeat(3000)}\n${'b'.repeat(3000)}`
  const parts = chunks(long)
  assert.ok(parts.length > 1, 'a reply over the cap was not split')
  assert.ok(parts.every(part => part.length <= MESSAGE_LIMIT), 'a part exceeded the cap')
  assert.equal(parts.join(''), long)
  // A newline near the limit is preferred, so paragraphs stay together.
  assert.equal(parts[0].endsWith('\n'), true)
  assert.deepEqual(chunks(''), [])
})

test('retries back off and stop growing', () => {
  assert.equal(retryDelayMs(1), 1000)
  assert.ok(retryDelayMs(2) > retryDelayMs(1))
  assert.ok(retryDelayMs(3) > retryDelayMs(2))
  assert.ok(retryDelayMs(50) <= 30_000)
  assert.ok(retryDelayMs(0) > 0, 'a backoff of zero would poll hot')
})
