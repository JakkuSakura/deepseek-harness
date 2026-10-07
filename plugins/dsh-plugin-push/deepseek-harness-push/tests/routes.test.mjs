/**
 * The Host routes against a fake context.
 *
 * This is where the security property is asserted rather than assumed: every route
 * is registered under `/api`, so DSH's browser-trust fence guards it. A client that
 * can subscribe receives Session titles, so subscribing must not be open.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, name } from '../lib/index.js'
import { subscriptionsPath } from '../lib/testing/store.js'

/** A context carrying only the route registry the plugin injects. */
function fakeContext() {
  const routes = new Map()
  const projections = new Map()
  const web = new Map()
  const effects = []
  return {
    routes,
    projections,
    web,
    effects,
    ctx: {
      webServer: { register: (route) => { web.set(route.path, route); return () => {} } },
      // Every registration in the plugin lives inside an effect, which is how cordis
      // ties it to the plugin's lifetime — and how the plugin came to be inert without
      // one. The fake has to call the body for a registration to happen at all.
      effect: (fn) => {
        effects.push(fn)
        const dispose = fn()
        return () => { if (typeof dispose === 'function') dispose() }
      },
      connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } },
      sessionProjections: { register: (definition) => { projections.set(definition.key, definition); return () => {} } },
      logger: { info: () => {}, warn: () => {} },
    },
  }
}

const call = (routes, path, body) => routes.get(path).fetch(new Request(`http://127.0.0.1${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}))

test('the plugin declares the route registry it needs', () => {
  assert.equal(name, 'push')
})

/** The only routes allowed to sit outside the fence, and why they may. */
const PUBLIC_ROUTES = ['/dsh-push-sw.js', '/dsh-push.webmanifest']

test('only the worker and the manifest are outside the /api fence', async () => {
  const { ctx, routes, web } = fakeContext()
  apply(ctx, { dataDir: await mkdtemp(join(tmpdir(), 'push-routes-')) })
  assert.ok(routes.size > 0)
  for (const path of routes.keys()) {
    assert.ok(path.startsWith('/api/'), `${path} is outside the browser-trust fence`)
  }
  // A service worker needs root scope and a browser will not install a manifest from
  // behind a trust check, so these two are public by necessity — static, no secrets,
  // and nothing else may join them.
  assert.deepEqual([...web.keys()].sort(), [...PUBLIC_ROUTES].sort())
})

test('the worker is served as JavaScript and the manifest parses', async () => {
  const { ctx, web } = fakeContext()
  apply(ctx, { dataDir: await mkdtemp(join(tmpdir(), 'push-assets-')) })
  const served = {}
  await new Promise((resolve) => {
    web.get('/dsh-push-sw.js').handler({}, {
      writeHead: () => {},
      end: (body) => { served.worker = body; resolve() },
    })
  })
  assert.match(served.worker, /addEventListener\('push'/, 'the worker must handle push')
  assert.match(served.worker, /showNotification/)
  let manifest = ''
  await new Promise((resolve) => {
    web.get('/dsh-push.webmanifest').handler({}, {
      writeHead: () => {},
      end: (body) => { manifest = body; resolve() },
    })
  })
  const parsed = JSON.parse(manifest)
  // Without a standalone manifest there is no Home Screen app, and no iOS push.
  assert.equal(parsed.display, 'standalone')
  assert.ok(parsed.name)
})

test('the public key is served and the private half never is', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'push-key-'))
  const { ctx, routes } = fakeContext()
  apply(ctx, { dataDir: dir })
  const body = await (await call(routes, '/api/push/key')).json()
  assert.equal(typeof body.publicKey, 'string')
  assert.ok(body.publicKey.length > 20, 'a VAPID public key is not a token')
  assert.equal(body.privateKey, undefined)
})

test('subscribing stores the browser, and unsubscribing forgets it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'push-sub-'))
  const { ctx, routes } = fakeContext()
  apply(ctx, { dataDir: dir })
  const subscription = { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } }
  const added = await (await call(routes, '/api/push/subscribe', subscription)).json()
  assert.deepEqual(added, { ok: true, subscriptions: 1 })
  assert.deepEqual(JSON.parse(await readFile(subscriptionsPath(dir), 'utf8')), [subscription])
  const again = await (await call(routes, '/api/push/subscribe', subscription)).json()
  assert.equal(again.subscriptions, 1, 'the same browser twice is still one subscription')
  const removed = await (await call(routes, '/api/push/unsubscribe', { endpoint: subscription.endpoint })).json()
  assert.equal(removed.subscriptions, 0)
})

test('the notifier is registered as a projection, because that is the only host tap', async () => {
  const { ctx, projections } = fakeContext()
  apply(ctx, { dataDir: await mkdtemp(join(tmpdir(), 'push-proj-')) })
  const definition = projections.get('pushNotifier')
  assert.ok(definition, 'no projection registered: the host would never see a turn')
  assert.equal(definition.stateVersion, 1)
  // Driving the fold the way the real driver does: init from the session header,
  // then apply. The state carries who this is, which is what a notification needs.
  const header = { id: 'session-abc', cwd: '/Users/x/Dev/FerroPhase' }
  let state = definition.init(header, 0)
  assert.deepEqual(state, { notified: 0, sessionId: 'session-abc', title: 'FerroPhase' })
  // One explicit time, not two `Date.now()` calls: the dedupe key contains the event's
  // time, so a second call that lands in a later millisecond is a *different* event and
  // is correctly announced again. That was a flake in this test, not in the plugin.
  const at = Date.now()
  state = definition.apply(state, { type: 'turn/end', time: at, data: { turn: 1 } })
  assert.equal(state.notified, 1, 'a recent turn end should have been announced')
  // Replaying the same event must not announce it again.
  assert.equal(definition.apply(state, { type: 'turn/end', time: at, data: { turn: 1 } }).notified, 1)
  // And history never announces at all.
  assert.equal(definition.apply(state, { type: 'turn/end', time: 0 }).notified, 1)
})

test('a malformed subscription is refused rather than stored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'push-bad-'))
  const { ctx, routes } = fakeContext()
  apply(ctx, { dataDir: dir })
  const response = await call(routes, '/api/push/subscribe', { endpoint: 'not-a-url' })
  assert.equal(response.status, 400)
  assert.deepEqual(JSON.parse(await readFile(subscriptionsPath(dir), 'utf8').catch(() => '[]')), [])
})
