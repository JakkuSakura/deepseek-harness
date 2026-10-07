/** The server's push identity: created once, then reused. */
import assert from 'node:assert/strict'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadOrCreateVapid, vapidPath } from '../lib/testing/vapid.js'

test('a key pair is created once and then reused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'push-vapid-'))
  let calls = 0
  const generate = () => { calls += 1; return { publicKey: `pub${String(calls)}`, privateKey: `priv${String(calls)}` } }
  const first = await loadOrCreateVapid(dir, generate)
  const second = await loadOrCreateVapid(dir, generate)
  // Regenerating would invalidate every subscription, so it must happen exactly once.
  assert.equal(calls, 1)
  assert.deepEqual(second, first)
  assert.deepEqual(JSON.parse(await (await import('node:fs/promises')).readFile(vapidPath(dir), 'utf8')), first)
})

test('the private half is not world-readable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'push-vapid-mode-'))
  await loadOrCreateVapid(dir, () => ({ publicKey: 'pub', privateKey: 'priv' }))
  const mode = (await stat(vapidPath(dir))).mode & 0o777
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
})
