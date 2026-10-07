/**
 * The service worker's source, served verbatim by the Host.
 *
 * It lives in a string rather than a `.js` file so the build stays ordinary: a
 * separate script would need a text loader and a module declaration for a file that
 * is never imported as code, and both are more moving parts than the escaping costs.
 *
 * @module dsh-plugin-push/worker-source
 */
export const WORKER_SOURCE = String.raw`/**
 * The service worker.
 *
 * The only thing that can show a notification when the page is not running, and on
 * iOS the only thing that runs at all while the web app is suspended.
 */
self.addEventListener('install', () => { self.skipWaiting() })

self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()) })

self.addEventListener('push', (event) => {
  var payload = { title: 'DeepSeek Harness', body: '', tag: 'dsh-push', renotify: true, data: {} }
  try {
    if (event.data) payload = Object.assign(payload, event.data.json())
  } catch (error) {
    // A push that is not the JSON this server sends is still worth showing.
    if (event.data) payload.body = event.data.text()
  }
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    // Tagged by Session, so a Session that interrupts twice replaces its own
    // notification rather than stacking.
    tag: payload.tag,
    renotify: payload.renotify,
    data: payload.data
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  var data = event.notification.data || {}
  var target = new URL(data.url || './', self.registration.scope).href
  event.waitUntil((async () => {
    var windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (var index = 0; index < windows.length; index += 1) {
      if (windows[index].url === target && 'focus' in windows[index]) return windows[index].focus()
    }
    return self.clients.openWindow(target)
  })())
})
`
