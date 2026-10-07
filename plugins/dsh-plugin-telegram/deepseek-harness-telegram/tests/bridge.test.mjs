/**
 * The bridge against a stub Bot API and a fake Host context.
 *
 * No DSH, no Telegram, no token: a local server answers `getUpdates` and a hand-made
 * context records what the plugin dispatches. This is what proves the two things
 * worth proving — that an allowed message becomes a delivery, and that a message
 * outside the allow-list never does.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { apply, inject, name } from '../lib/index.js'

/** Serve one batch of updates, then hold every later poll open, as Telegram does. */
async function stubApi(batches) {
  const calls = []
  const server = createServer((request, response) => {
    calls.push(request.url)
    const batch = batches.shift() ?? []
    // A poll that has nothing to say is held briefly rather than answered hot.
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, result: batch }))
    }, batch.length === 0 ? 20 : 0)
  })
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address()
  return { calls, origin: `http://127.0.0.1:${String(port)}`, close: () => { server.close() } }
}

/** A Host context carrying only what this plugin injects. */
function fakeContext() {
  let cleanup
  return {
    dispatched: [],
    warnings: [],
    ctx: {
      credentials: { resolve: async () => 'test-token' },
      webhookRuntime: { dispatch: delivery => { this.dispatched.push(delivery) } },
      logger: { warn: (...args) => {} },
      effect: (fn) => { cleanup = fn() },
    },
    stop: () => { cleanup?.() },
  }
}

const message = (updateId, chatId, userId = 99) => ({
  update_id: updateId,
  message: { message_id: updateId, chat: { id: chatId }, from: { id: userId }, text: `task ${String(updateId)}` },
})

test('the plugin declares the services it needs', () => {
  assert.equal(name, 'telegram')
  assert.deepEqual(inject, ['webhookRuntime', 'credentials'])
})

test('an allowed message becomes a delivery, and a stranger never does', async () => {
  const api = await stubApi([[
    message(1, 42),
    // Same bot, different chat: must not reach the runtime.
    message(2, 999),
    // Right chat, wrong user: must not either.
    message(3, 42, 1234),
  ]])
  const host = fakeContext()
  const dispatched = []
  const warnings = []
  let cleanup
  apply({
    credentials: { resolve: async () => 'test-token' },
    webhookRuntime: { dispatch: delivery => { dispatched.push(delivery) } },
    logger: { warn: (...args) => { warnings.push(args.join(' ')) } },
    effect: (fn) => { cleanup = fn() },
  }, {
    botTokenRef: 'TELEGRAM_BOT_TOKEN',
    allowedChats: ['42'],
    allowedUsers: ['99'],
    apiBase: api.origin,
  })
  try {
    const deadline = Date.now() + 3000
    while (dispatched.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(dispatched.length, 1, 'exactly the allowed message should have been delivered')
    const delivery = dispatched[0]
    assert.equal(delivery.kind, 'telegram')
    assert.equal(delivery.deliveryId, '1')
    assert.deepEqual(delivery.event, { chatId: '42', userId: '99', messageId: 1, text: 'task 1' })
  } finally {
    cleanup?.()
    api.close()
  }
  assert.ok(warnings.some(line => line.includes('ignored a message from chat 999')), 'the stranger was not reported')
})

test('with no allow-list configured, nothing is dispatched', async () => {
  const api = await stubApi([[message(1, 42)]])
  const dispatched = []
  let cleanup
  apply({
    credentials: { resolve: async () => 'test-token' },
    webhookRuntime: { dispatch: delivery => { dispatched.push(delivery) } },
    logger: { warn: () => {} },
    effect: (fn) => { cleanup = fn() },
  }, { botTokenRef: 'TELEGRAM_BOT_TOKEN', apiBase: api.origin })
  try {
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.deepEqual(dispatched, [], 'an unconfigured bridge dispatched something')
  } finally {
    cleanup?.()
    api.close()
  }
})
