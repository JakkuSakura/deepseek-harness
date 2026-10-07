/** What a delivery attempt means for the subscription. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deliver } from '../lib/testing/sender.js'

const subscription = { endpoint: 'https://push/a', keys: { p256dh: 'k', auth: 'a' } }
const message = { title: 't', body: 'b', tag: 's1', renotify: true, data: { sessionId: 's1' } }

test('a delivery that the push service accepted is sent', async () => {
  const seen = []
  const outcome = await deliver(async (target, payload) => { seen.push([target.endpoint, JSON.parse(payload)]) }, subscription, message)
  assert.equal(outcome, 'sent')
  assert.deepEqual(seen[0], ['https://push/a', message])
})

test('gone subscriptions are pruned; everything else is merely failed', async () => {
  const fail = (statusCode) => async () => { throw Object.assign(new Error('rejected'), { statusCode }) }
  assert.equal(await deliver(fail(404), subscription, message), 'prune')
  assert.equal(await deliver(fail(410), subscription, message), 'prune')
  for (const status of [429, 500, 503]) {
    assert.equal(await deliver(fail(status), subscription, message), 'failed', `status ${status} must not unsubscribe`)
  }
  // A network error has no status at all, and must not unsubscribe either.
  assert.equal(await deliver(async () => { throw new Error('offline') }, subscription, message), 'failed')
})
