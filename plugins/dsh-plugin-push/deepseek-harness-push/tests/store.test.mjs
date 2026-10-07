/** The subscription list, on disk and in memory. */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { addSubscription, readSubscriptions, removeSubscription, subscriptionsPath, writeSubscriptions } from '../lib/testing/store.js'

const sub = (endpoint) => ({ endpoint, keys: { p256dh: 'k', auth: 'a' } })

test('an endpoint appears once, however often it subscribes', () => {
  const once = addSubscription([], sub('https://push/a'))
  const twice = addSubscription(once, sub('https://push/a'))
  assert.equal(twice.length, 1, 'the same browser subscribed twice would notify twice')
  assert.equal(addSubscription(twice, sub('https://push/b')).length, 2)
})

test('removing takes only the one endpoint', () => {
  const list = [sub('https://push/a'), sub('https://push/b')]
  assert.deepEqual(removeSubscription(list, 'https://push/a').map(s => s.endpoint), ['https://push/b'])
  assert.deepEqual(removeSubscription(list, 'https://push/zzz').length, 2)
})

test('the list survives a round trip, and a damaged file reads as empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'push-store-'))
  assert.deepEqual(await readSubscriptions(dir), [], 'a directory with no file yet is not an error')
  await writeSubscriptions(dir, [sub('https://push/a')])
  assert.deepEqual((await readSubscriptions(dir)).map(s => s.endpoint), ['https://push/a'])
  // A truncated file must not take the plugin down; it must mean "nobody subscribed".
  await writeFile(subscriptionsPath(dir), '{ not json')
  assert.deepEqual(await readSubscriptions(dir), [])
})
