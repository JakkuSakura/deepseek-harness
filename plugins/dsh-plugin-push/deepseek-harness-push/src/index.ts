/**
 * Web Push notifications for the DeepSeek Harness.
 *
 * The Host half owns everything that must outlive a browser tab: the server's push
 * identity, the subscriptions, and the sending. That division is the point — a
 * notification that only fires while a page is open is not a notification, and on
 * iOS the web app is suspended when it is not in front, so the *server* must be the
 * one that sends.
 *
 * Every route is registered under `/api`, which DSH's browser-trust fence guards.
 * That placement is deliberate: a browser that subscribed here receives Session
 * titles, so subscribing must not be something a stray client on the network can do.
 *
 * @module dsh-plugin-push
 */
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-projection'
import webpush from 'web-push'
import { z } from 'zod'
import { type PushTrigger, notificationFor, normalizeSubject, readSubscription } from './push.ts'
import { deliver } from './sender.ts'
import { addSubscription, readSubscriptions, removeSubscription, writeSubscriptions } from './store.ts'
import { type SessionEventLike, noticeForEvent, noticeKey } from './trigger.ts'
import { type VapidKeys, loadOrCreateVapid } from './vapid.ts'
import { WORKER_SOURCE } from './worker-source.ts'

/** Cordis plugin name. */
export const name = 'push'

/**
 * The route registry, and the projection seam — which is how the Host sees Session
 * events at all. There is no listener API: a projection *is* the host-side tap.
 */
export const inject = ['connection', 'sessionProjections', 'webServer']

/** What the plugin needs from its row. */
export interface PushConfig {
  /** Where the keys and subscriptions live. Defaults beside the other profile state. */
  readonly dataDir?: string
  /** A `mailto:` or `https://` contact for the push services, as VAPID requires. */
  readonly subject?: string
}

/** The data directory, honouring an isolated `DSH_HOME`. */
function defaultDataDir(): string {
  const home = process.env['DSH_HOME']
  return join(home !== undefined && home !== '' ? home : join(homedir(), '.dsh'), 'push')
}

/** Where the browser half looks for the worker, and the manifest it installs from. */
export const WORKER_ROUTE = '/dsh-push-sw.js'
export const MANIFEST_ROUTE = '/dsh-push.webmanifest'

/** The web app manifest. iOS reads this at "Add to Home Screen", which push requires. */
const MANIFEST = {
  name: 'DeepSeek Harness',
  short_name: 'DSH',
  // Relative, so the installed app opens on whatever origin it was installed from.
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: '#0b0b0c',
  theme_color: '#0b0b0c',
}

/** A JSON response, with the content type the client half expects. */
function json(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Register the push service.
 * @param ctx - Host context carrying the route registry.
 * @param config - this plugin's row.
 */
export function apply(ctx: Context, config: PushConfig): void {
  const dataDir = config.dataDir ?? defaultDataDir()
  const subject = normalizeSubject(config.subject) ?? 'https://github.com/deepseek-ai'
  let keys: VapidKeys | undefined

  /**
   * Load the identity once per process, and tell the library about it.
   * @returns the key pair in use.
   */
  const identity = async (): Promise<VapidKeys> => {
    keys ??= await loadOrCreateVapid(dataDir, () => webpush.generateVAPIDKeys())
    webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey)
    return keys
  }

  /**
   * Send a notification to every subscription, dropping the ones that are gone.
   * @param message - what to send.
   * @returns how it went, in counts.
   */
  const broadcast = async (message: ReturnType<typeof notificationFor>): Promise<{
    sent: number
    pruned: number
    failed: number
  }> => {
    await identity()
    const stored = await readSubscriptions(dataDir)
    let sent = 0
    let failed = 0
    const gone: string[] = []
    for (const subscription of stored) {
      const outcome = await deliver(
        async (target, payload) => { await webpush.sendNotification(target, payload) },
        subscription,
        message,
      )
      if (outcome === 'sent') sent += 1
      else if (outcome === 'prune') gone.push(subscription.endpoint)
      else {
        failed += 1
        // Loud, because a notification that silently never arrives is the failure
        // mode that makes people stop trusting the feature.
        ctx.logger.warn(`push: delivery to ${subscription.endpoint} failed`)
      }
    }
    if (gone.length > 0) {
      let list = stored
      for (const endpoint of gone) list = removeSubscription(list, endpoint)
      await writeSubscriptions(dataDir, list)
    }
    return { sent, pruned: gone.length, failed }
  }

  const routes: { path: string; methods: ['GET' | 'POST']; handler: (request: Request) => Promise<Response> }[] = [
    {
      path: '/api/push/key',
      methods: ['GET'],
      // The public half only. The private half never leaves this process.
      handler: async () => json({ publicKey: (await identity()).publicKey }),
    },
    {
      path: '/api/push/subscribe',
      methods: ['POST'],
      handler: async (request) => {
        const subscription = readSubscription(await request.json().catch(() => null))
        if (subscription === null) return json({ ok: false, error: 'not a push subscription' }, 400)
        const list = addSubscription(await readSubscriptions(dataDir), subscription)
        await writeSubscriptions(dataDir, list)
        ctx.logger.info(`push: ${String(list.length)} subscription(s)`)
        return json({ ok: true, subscriptions: list.length })
      },
    },
    {
      path: '/api/push/unsubscribe',
      methods: ['POST'],
      handler: async (request) => {
        const body = await request.json().catch(() => null) as { endpoint?: unknown } | null
        const endpoint = body?.endpoint
        if (typeof endpoint !== 'string' || endpoint === '') return json({ ok: false, error: 'endpoint required' }, 400)
        const list = removeSubscription(await readSubscriptions(dataDir), endpoint)
        await writeSubscriptions(dataDir, list)
        return json({ ok: true, subscriptions: list.length })
      },
    },
    {
      path: '/api/push/test',
      methods: ['POST'],
      // Deliberately part of the product rather than a debug hatch: this is how the
      // whole path — key, subscription, push service, service worker — gets proved
      // before any trigger depends on it.
      handler: async (request) => {
        const body = await request.json().catch(() => null) as { trigger?: unknown } | null
        const trigger = body?.trigger
        const chosen: PushTrigger =
          trigger === 'needs-input' || trigger === 'error' || trigger === 'finished' ? trigger : 'finished'
        const result = await broadcast(notificationFor({
          trigger: chosen,
          sessionId: 'test',
          title: 'Test notification',
          detail: 'If you can read this, the whole path works.',
        }))
        return json({ ok: true, ...result })
      },
    },
    {
      path: '/api/push/notify',
      methods: ['POST'],
      // The page reports what only the page can see: a Session waiting for input.
      // The fold cannot know this, and on iOS the page is the only thing that saw it
      // before it was suspended.
      handler: async (request) => {
        const body = await request.json().catch(() => null) as
          { sessionId?: unknown; title?: unknown; detail?: unknown; trigger?: unknown } | null
        const sessionId = typeof body?.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : ''
        if (sessionId === '') return json({ ok: false, error: 'sessionId required' }, 400)
        const chosen: PushTrigger = body?.trigger === 'error' ? 'error' : body?.trigger === 'finished' ? 'finished' : 'needs-input'
        const result = await broadcast(notificationFor({
          trigger: chosen,
          sessionId,
          ...(typeof body?.title === 'string' && body.title !== '' ? { title: body.title } : {}),
          ...(typeof body?.detail === 'string' && body.detail !== '' ? { detail: body.detail } : {}),
        }))
        return json({ ok: true, ...result })
      },
    },
  ]

  /** One notification per real event, even when a fold is driven twice. */
  const announced = new Set<string>()

  /** The fold's state: who this session is, plus a count that makes it meaningful. */
  const notifierState = z.object({
    notified: z.number(),
    sessionId: z.string(),
    title: z.string(),
  })

  // The Host's only view of Session events. A projection is a fold over the whole
  // log and is replayed from a stored row on startup, so `apply` must be safe to run
  // over history — which is exactly why the decision lives in `noticeForEvent`,
  // where the recency guard can be tested rather than hoped for.
  const notifierDefinition = {
    key: 'pushNotifier',
    stateVersion: 1,
    stateSchema: notifierState,
    init: (header: { id?: unknown; cwd?: unknown }) => ({
      notified: 0,
      sessionId: typeof header?.id === 'string' ? header.id : '',
      // A workspace name is what a person recognises in a notification; the session
      // id is not.
      title: typeof header?.cwd === 'string' && header.cwd !== '' ? basename(header.cwd) : '',
    }),
    apply: (state: z.infer<typeof notifierState>, event: SessionEventLike) => {
      const notice = noticeForEvent(event, state.sessionId, Date.now())
      if (notice === null) return state
      const key = noticeKey(notice, event)
      if (announced.has(key)) return state
      announced.add(key)
      void broadcast(notificationFor({ ...notice, ...(state.title === '' ? {} : { title: state.title }) }))
        .catch((error: unknown) => { ctx.logger.warn(`push: broadcast failed: ${String(error)}`) })
      return { ...state, notified: state.notified + 1 }
    },
    wire: {
      viewSchema: notifierState,
      view: (state: z.infer<typeof notifierState>) => state,
    },
  }

  // The published types for this seam are older than the runtime they describe:
  // they declare `init()` with no arguments and `apply` with an untyped event, while
  // the driver in the installed build calls `init(header, inheritedEventCount)` and
  // `apply(state, event)`. One cast at the boundary, recorded so the mismatch is not
  // rediscovered as a mystery later.
  ctx.sessionProjections.register(
    notifierDefinition as unknown as Parameters<typeof ctx.sessionProjections.register>[0],
  )

  // These two are deliberately *outside* the `/api` fence: a service worker must be
  // served from the origin root to get root scope, and a browser will not install a
  // manifest from behind a trust check. Both are static and hold no secret, which is
  // why they are the only routes that may live here — a test asserts exactly that.
  // Registered inside an effect, like every other route in the tree: a bare
  // `register()` outside one is inert, which is a silence that looks exactly like a
  // plugin that never loaded.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: WORKER_ROUTE,
    handler: (_request, response) => {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        // A worker is cacheable, but a stale one is undebuggable.
        'cache-control': 'no-cache',
      })
      response.end(WORKER_SOURCE)
    },
  }), 'push: service worker route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MANIFEST_ROUTE,
    handler: (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' })
      response.end(`${JSON.stringify(MANIFEST, null, 2)}\n`)
    },
  }), 'push: manifest route')

  ctx.logger.info(`push: applied — worker ${WORKER_ROUTE}, manifest ${MANIFEST_ROUTE}, keys under ${dataDir}`)

  for (const route of routes) {
    ctx.logger.info(`push: route ${route.path}`)
    ctx.effect(() => ctx.connection.fetch.register({
      path: route.path,
      methods: route.methods,
      requestBody: 'buffered',
      fetch: (request: Request) => route.handler(request),
    }), `push: ${route.path}`)
  }
}
