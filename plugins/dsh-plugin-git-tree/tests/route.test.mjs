/**
 * What a route read says when the answer is not the JSON it asked for.
 *
 * The case that produced this: the Host half of a plugin mounts once at boot, so
 * a route added since the server started is not registered, and the fence answers
 * the plain text `not found`. Parsing that as JSON threw
 * `Unexpected token 'o', "not found" is not valid JSON` — the symptom, and no clue
 * about the route or the reason.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readJsonRoute } from '../lib/testing/client-route.js'

const response = (status, text) => new Response(text, { status })

test('a JSON body is parsed', async () => {
  const read = await readJsonRoute('the route', response(200, '{"status":"ok"}'))
  assert.deepEqual(read, { ok: true, body: { status: 'ok' } })
})

test('a 404 names the route and the likely reason rather than a parser complaint', async () => {
  const read = await readJsonRoute('the diff route', response(404, 'not found'))
  assert.equal(read.ok, false)
  assert.equal(read.code, 'route-missing')
  assert.match(read.message, /the diff route is not registered on this Host/)
  assert.match(read.message, /404: not found/)
  assert.match(read.message, /restarting dsh web/)
  // The parser's own words never reach the operator.
  assert.doesNotMatch(read.message, /Unexpected token|is not valid JSON/)
})

test('a non-JSON body that is not a 404 reports the status and what came back', async () => {
  const read = await readJsonRoute('the git stats route', response(502, '<html>bad gateway</html>'))
  assert.equal(read.ok, false)
  assert.equal(read.code, 'not-json')
  assert.match(read.message, /answered 502 with <html>bad gateway<\/html>/)
})

test('a long body is clipped to one line', async () => {
  const read = await readJsonRoute('the route', response(500, `${'x'.repeat(400)}\nsecond line`))
  assert.equal(read.ok, false)
  assert.equal(read.message.includes('second line'), false)
  assert.match(read.message, /…/u)
})

test('an empty body is described rather than reported as a parse failure', async () => {
  const read = await readJsonRoute('the route', response(200, ''))
  assert.equal(read.ok, false)
  assert.equal(read.code, 'not-json')
  assert.match(read.message, /\(an empty body\)/)
})
