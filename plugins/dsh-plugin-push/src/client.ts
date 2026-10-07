/**
 * The browser half.
 *
 * Deliberately UI-free: it renders nothing, so it needs no framework. What it does
 * is the part only a browser can do — register the worker, ask for permission,
 * subscribe, and hand the subscription to the Host.
 *
 * Permission is requested **on a user gesture**, which is not politeness: iOS
 * refuses to prompt otherwise, and a prompt that appears without a tap is the
 * fastest way to get a site denied for good.
 *
 * @module dsh-plugin-push/client
 */
import { createElement, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { bytesFromUrlBase64 } from './push.ts'

/** Where the Host serves the worker. Its directory is the app root, so is its scope. */
const WORKER_PATH = 'dsh-push-sw.js'

/** Where the Host serves the manifest, which iOS reads at "Add to Home Screen". */
const MANIFEST_PATH = 'dsh-push.webmanifest'

/** Link the manifest, so iOS can install the app that receives push. */
function linkManifest(): void {
  if (document.querySelector('link[rel="manifest"]') !== null) return
  const link = document.createElement('link')
  link.rel = 'manifest'
  link.href = MANIFEST_PATH
  document.head.append(link)
}

/**
 * Say where the client half is, because silence is indistinguishable from absence.
 *
 * This runs in a browser nobody is watching unless something goes wrong, and the one
 * question that matters — "did the client half even load?" — cannot be answered from
 * the server, because a plugin that never mounts makes no requests. Every step below
 * therefore names itself.
 * @param step - what is being attempted.
 * @param detail - anything worth adding.
 */
function report(step: string, detail?: unknown): void {
  const line = detail === undefined ? step : `${step}: ${String(detail)}`
  if (detail === undefined) console.info(`push: ${step}`)
  else console.info(`push: ${step}`, detail)
  // Also on the document, because a console is only useful to someone who knows to
  // open one. This is what a support question can be answered from: read the attribute
  // and the last line names the step that failed.
  try {
    const root = document.documentElement
    const log = `${root.dataset['pushLog'] ?? ''}${root.dataset['pushLog'] === undefined ? '' : ' | '}${line}`
    root.dataset['pushLog'] = log.length > 600 ? log.slice(-600) : log
  } catch {
    // A document without a dataset is not worth failing over.
  }
}

/**
 * Register the worker.
 *
 * Done on load rather than on a gesture, because registering a worker needs no
 * permission — only subscribing does. It also makes the failure visible: the worker
 * either appears in the browser's application panel or it does not, which is a
 * one-glance answer to whether this half is running at all.
 * @returns the registration, or null when the worker could not be registered.
 */
async function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  try {
    if (!('serviceWorker' in navigator)) {
      report('no service worker support; notifications are unavailable')
      return null
    }
    const registration = await navigator.serviceWorker.register(WORKER_PATH, { scope: './' })
    report('worker registered')
    return registration
  } catch (error: unknown) {
    report('worker registration failed', error)
    return null
  }
}

/**
 * Ask for permission and subscribe.
 *
 * Every step is guarded: a browser without push — or one where the reader has already
 * refused — must leave the app working, just without notifications.
 * @param ready - the worker registration, when one was obtained on load.
 * @returns nothing; each outcome is reported to the console.
 */
async function subscribe(ready: Promise<ServiceWorkerRegistration | null>): Promise<void> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      report('no push support; notifications are unavailable')
      return
    }
    if (Notification.permission === 'denied') {
      report('permission was denied; allow notifications for this site and reload')
      return
    }
    if (Notification.permission === 'default') {
      // Inside the gesture that triggered this, or iOS will not prompt.
      const permission = await Notification.requestPermission()
      report(`permission ${permission}`)
      if (permission !== 'granted') return
    }
    const registration = await ready
    if (registration === null) return
    const keyResponse = await fetch('api/push/key', { headers: { accept: 'application/json' } })
    if (!keyResponse.ok) {
      report(`key request failed: ${String(keyResponse.status)}`)
      return
    }
    const { publicKey } = await keyResponse.json() as { publicKey?: unknown }
    if (typeof publicKey !== 'string' || publicKey === '') {
      report('the server served no VAPID key')
      return
    }
    const existing = await registration.pushManager.getSubscription()
    const subscription = existing ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: bytesFromUrlBase64(publicKey),
    })
    const stored = await fetch('api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    })
    report(`subscribed; the server answered ${String(stored.status)}`)
  } catch (error: unknown) {
    report('could not subscribe', error)
  }
}

/**
 * Register the browser half.
 * @param _ctx - the client context; unused, which is why this half needs nothing injected.
 */
export function apply(ctx: { slots?: { inject: (name: string, register: () => unknown) => () => void, register: (options: unknown, component: unknown) => () => void } }): void {
  report('client half loaded')
  linkManifest()
  if (!('serviceWorker' in navigator)) return
  workerReady = registerWorker()
  // A button in the composer's dock: visible, one click, and the click is the gesture
  // the permission prompt requires.
  if (ctx.slots === undefined) {
    // Silence here is indistinguishable from a button nobody noticed, which is how the
    // first version failed.
    report('no slot registry was injected; the button cannot appear')
    return
  }
  // `id`, not `key`: this is a list slot, where entries are keyed by id. The sidebar
  // slot in the git plugin uses `key` because that one is a keyed slot, and copying it
  // here registered nothing at all — no error, no button.
  try {
    ctx.slots.inject(DOCK, () => ctx.slots?.register({ name: DOCK, id: 'dsh-push-enable', order: 0 }, EnableButton))
    report('button registered into the composer dock')
  } catch (error: unknown) {
    report('could not register the button', error)
  }
}

/** The slot registry, so the button has somewhere to live. */
export const inject = ['slots']

/** Where the button goes: the composer's dock, beside the harness's own pill. */
const DOCK = 'conversation.composer.dock'

/** The worker registration, shared with the button. */
let workerReady: Promise<ServiceWorkerRegistration | null> | null = null

/**
 * A button that asks for notifications.
 *
 * This is the fix for a real defect: the first version asked the reader to tap
 * *anywhere*, and nothing on screen said so. An affordance nobody can see is not one,
 * and the feature simply never subscribed for anyone who did not already know. A
 * button is also the one gesture browsers accept for the permission prompt.
 * @returns the button, or nothing once notifications are on.
 */
function EnableButton(): ReactNode {
  const [state, setState] = useState<'idle' | 'asking' | 'on' | 'off'>(() =>
    (typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'on' : 'idle'))

  // A subscription made in an earlier visit is still live, and the button should say
  // so rather than invite the reader to do it again.
  useEffect(() => {
    if (workerReady === null) return
    void workerReady.then(async (registration) => {
      if (registration === null) return
      const existing = await registration.pushManager.getSubscription()
      if (existing !== null) setState('on')
    }).catch(() => {})
  }, [])

  if (state === 'on') {
    return createElement('span', {
      style: { fontSize: '11px', opacity: 0.7, padding: '2px 6px' },
    }, 'notifications on')
  }
  return createElement('button', {
    type: 'button',
    style: {
      fontSize: '11px', lineHeight: '16px', padding: '2px 8px', cursor: 'pointer',
      color: 'inherit', background: 'none', border: '1px solid currentColor',
      borderRadius: '999px', opacity: state === 'asking' ? 0.6 : 0.85,
    },
    disabled: state === 'asking',
    onClick: () => {
      setState('asking')
      void subscribe(workerReady ?? Promise.resolve(null)).then(() => {
        setState(typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'on' : 'off')
      })
    },
  }, state === 'asking' ? 'asking…' : state === 'off' ? 'notifications blocked' : 'enable notifications')
}
