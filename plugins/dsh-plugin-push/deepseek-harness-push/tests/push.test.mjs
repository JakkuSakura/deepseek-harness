/** The pure rules: what a notification says, and how a push answer is read. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bytesFromUrlBase64, notificationFor, normalizeSubject, readSubscription, shouldPrune } from '../lib/testing/push.js'

test('each trigger gets its own headline, and the session is the tag', () => {
  const base = { sessionId: 's1', title: 'FerroPhase' }
  assert.match(notificationFor({ ...base, trigger: 'needs-input' }).title, /needs you/)
  assert.match(notificationFor({ ...base, trigger: 'finished' }).title, /finished/)
  assert.match(notificationFor({ ...base, trigger: 'error' }).title, /failed/)
  // Tagging by session collapses repeats instead of stacking them — the thing that
  // makes people switch notifications off.
  assert.equal(notificationFor({ ...base, trigger: 'finished' }).tag, 's1')
})

test('the body carries the session and any detail, and never an empty dash', () => {
  assert.equal(notificationFor({ trigger: 'finished', sessionId: 's1', title: 'FerroPhase' }).body, 'FerroPhase')
  assert.equal(
    notificationFor({ trigger: 'needs-input', sessionId: 's1', title: 'FerroPhase', detail: 'approve the patch' }).body,
    'FerroPhase — approve the patch',
  )
  // No title: the session id is better than an empty headline.
  assert.equal(notificationFor({ trigger: 'error', sessionId: 's1' }).body, 's1')
  assert.equal(notificationFor({ trigger: 'error', sessionId: 's1', detail: '   ' }).body, 's1')
})

test('only a gone subscription is pruned', () => {
  assert.equal(shouldPrune(404), true)
  assert.equal(shouldPrune(410), true)
  // A rate limit or a bad minute must never unsubscribe someone.
  assert.equal(shouldPrune(429), false)
  assert.equal(shouldPrune(500), false)
  assert.equal(shouldPrune(201), false)
})

test('a subscription is validated rather than trusted', () => {
  const good = { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } }
  assert.deepEqual(readSubscription(good), good)
  assert.equal(readSubscription({ ...good, endpoint: 'http://insecure' }), null)
  assert.equal(readSubscription({ endpoint: good.endpoint }), null)
  assert.equal(readSubscription({ endpoint: good.endpoint, keys: { p256dh: '', auth: 'a' } }), null)
  assert.equal(readSubscription(null), null)
  assert.equal(readSubscription('nope'), null)
})

test('the VAPID subject is only accepted in the two forms push services take', () => {
  assert.equal(normalizeSubject('mailto:me@example.com'), 'mailto:me@example.com')
  assert.equal(normalizeSubject('  https://example.com  '), 'https://example.com')
  assert.equal(normalizeSubject('example.com'), undefined)
  assert.equal(normalizeSubject(undefined), undefined)
})

test('a VAPID public key decodes to the bytes pushManager wants', () => {
  // URL-safe base64 with no padding, which is how VAPID keys are written.
  assert.deepEqual([...bytesFromUrlBase64('AAAA')], [0, 0, 0])
  assert.deepEqual([...bytesFromUrlBase64('-_8')], [251, 255])
  const key = bytesFromUrlBase64('BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM')
  assert.equal(key.length, 65, 'a P-256 public key is 65 bytes')
  assert.equal(key[0], 4, 'uncompressed point form')
})
