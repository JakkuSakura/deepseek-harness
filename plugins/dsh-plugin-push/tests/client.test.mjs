/**
 * The browser half, loaded the way the shell loads it.
 *
 * This exists because of a real defect: the first version had no affordance, so nobody
 * ever subscribed and nothing reported why. A test that the button is actually
 * registered is the cheapest way to keep that from happening again.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import react from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const requireFromHere = createRequire(import.meta.url)

/** Load the closure-factory bundle the way the shell does, and return its factory. */
async function loadBundle() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registration = null
  const window = { __ModuleLoader__: { load: (value) => { registration = value } } }
  // eslint-disable-next-line no-new-func -- the bundle's own entry form
  new Function('window', source)(window)
  assert.ok(registration, 'the bundle did not register itself')
  return registration
}

/** The browser surface the bundle touches, minimal but not absent. */
function stubBrowser() {
  const listeners = []
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ set rel(v) {}, set href(v) {} }),
    head: { append: () => {} },
    addEventListener: (type, fn) => listeners.push([type, fn]),
    removeEventListener: () => {},
  }
  // Defined, not assigned: Node already declares `navigator` as a getter-only global.
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  define('navigator', { serviceWorker: { register: async () => ({ scope: '/' }) } })
  define('Notification', { permission: 'default', requestPermission: async () => 'granted' })
  define('window', { PushManager: function PushManager() {} })
  return { listeners }
}

test('the bundle is the closure-factory form and exports the plugin shape', async () => {
  const registration = await loadBundle()
  assert.equal(registration.id, 'dsh-plugin-push')
  const module = registration.factory((name) => (name === 'react' ? react : requireFromHere(name)))
  assert.deepEqual(Object.keys(module).sort(), ['apply', 'inject'])
  assert.deepEqual(module.inject, ['slots'])
})

test('applying it registers a button into the composer dock', async () => {
  stubBrowser()
  const registration = await loadBundle()
  const module = registration.factory((name) => (name === 'react' ? react : requireFromHere(name)))
  const registered = []
  let injectedInto = null
  module.apply({
    slots: {
      inject: (name, register) => { injectedInto = name; register(); return () => {} },
      register: (options, component) => { registered.push({ options, component }); return () => {} },
    },
  })
  // The tap-anywhere version had no affordance at all; this is the fix, asserted.
  assert.equal(injectedInto, 'conversation.composer.dock')
  assert.equal(registered.length, 1)
  // A list slot keys its entries by `id`. Registering with `key` — correct for the
  // keyed sidebar slot and wrong here — silently produced no button at all.
  assert.equal(registered[0].options.id, 'dsh-push-enable')
  assert.equal(registered[0].options.name, 'conversation.composer.dock')
  // Not rendered here: it is a hook component, and calling one outside a renderer
  // throws. That a component is registered into the dock at all is the regression
  // worth holding — the version that failed shipped no affordance.
  assert.equal(typeof registered[0].component, 'function')
  assert.equal(registered[0].component.length, 0)
})

test('the registered component renders, rather than throwing and blanking the dock', () => {
  stubBrowser()
  return loadBundle().then((registration) => {
    const module = registration.factory((name) => (name === 'react' ? react : requireFromHere(name)))
    let component = null
    module.apply({
      slots: {
        inject: (_name, register) => { register(); return () => {} },
        register: (_options, value) => { component = value; return () => {} },
      },
    })
    assert.equal(typeof component, 'function')
    // This is the check that matters for a slot: a component that throws takes the whole
    // dock with it, and DSH's own pill disappears along with the new button. Rendering it
    // here names the error instead of leaving a blank row to wonder about.
    const markup = renderToStaticMarkup(react.createElement(component))
    assert.match(markup, /enable notifications/i)
  })
})
