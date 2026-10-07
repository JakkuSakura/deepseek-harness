#!/usr/bin/env node
/**
 * Transpile the Host half.
 *
 * One artifact: `lib/index.js`, ESM, `platform: node`. Every bare specifier stays
 * external so the plugin resolves DSH's services through the running installation
 * rather than shipping its own copy of any of them. `lib/testing/` is the same
 * source built for the test runner to import.
 */
import { build } from 'esbuild'
import { readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const external = Object.keys(manifest.devDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/'))

await rm(resolve(root, 'lib'), { recursive: true, force: true })
await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(root, 'lib/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external,
  logLevel: 'warning',
})
await build({
  entryPoints: [resolve(root, 'src/telegram.ts')],
  outfile: resolve(root, 'lib/testing/telegram.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  external,
  logLevel: 'warning',
})
console.log('build: wrote lib/index.js and lib/testing/telegram.js')
