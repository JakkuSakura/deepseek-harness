#!/usr/bin/env node
/**
 * Transpile both halves.
 *
 * The Host half is ESM for node; DSH packages stay external so the plugin resolves
 * services through the running installation, while `web-push` is inlined because it
 * is an ordinary library rather than a seam.
 *
 * The browser half is the DSH closure-factory form, and is deliberately UI-free: it
 * registers a service worker, asks for permission and reports the subscription. It
 * renders nothing, so it needs no framework.
 */
import { build } from 'esbuild'
import { readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const platform = Object.keys(manifest.devDependencies ?? {}).filter(n => n.startsWith('@deepseek-ai/'))

await rm(resolve(root, 'lib'), { recursive: true, force: true })
await build({
  entryPoints: [resolve(root, 'src/client.ts')],
  outfile: resolve(root, 'lib/client.js'),
  bundle: true, format: 'cjs', platform: 'browser', target: 'es2022',
  // React is the shell's: a second copy would break hooks and context.
  external: [...platform, 'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  // The DSH closure-factory handoff: the banner opens the factory and declares the
  // CommonJS bindings `format: 'cjs'` writes to, the footer closes both and returns
  // what the module table materializes.
  banner: {
    js: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(manifest.name) + ', factory: (require) => {'
      + ' var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
})
await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(root, 'lib/index.js'),
  bundle: true, format: 'esm', platform: 'node', target: 'node22',
  external: platform, logLevel: 'warning',
  // `web-push` is CommonJS, and inlining it into ESM leaves its `require("crypto")`
  // with nothing to call. A real `require` for this module restores it.
  banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
})
// The pure modules, built for the test runner. Each is a unit the tests import
// directly, so a rule can be checked without a browser, a key pair or a network.
for (const unit of ['push', 'store', 'vapid', 'sender', 'trigger']) {
  await build({
    entryPoints: [resolve(root, `src/${unit}.ts`)],
    outfile: resolve(root, `lib/testing/${unit}.js`),
    bundle: true, format: 'esm', platform: 'node', external: platform, logLevel: 'warning',
  })
}

// The shell shares a frozen module table; anything else a require() asks for would
// throw in the browser, so the build refuses it here instead.
const PLATFORM_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
])
const browserSource = await readFile(resolve(root, 'lib/client.js'), 'utf8')
const asked = new Set([...browserSource.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/gu)].map(m => m[2]))
const undeclared = [...asked].filter(name => !PLATFORM_MODULES.has(name))
if (undeclared.length > 0) {
  throw new Error(`build: lib/client.js requires ${undeclared.join(', ')}, which the module table cannot answer`)
}

console.log('build: wrote lib/index.js, lib/client.js and lib/testing/**')
