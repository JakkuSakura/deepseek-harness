#!/usr/bin/env node
/**
 * Apply this bundle's patches to the installed DeepSeek Harness packages.
 *
 * These are not part of the plugin: they change DSH's own code, which ships as
 * built packages with no sources. So each patch is a literal find-and-replace
 * against a **build artefact**, and each one is written to fail loudly rather than
 * half-apply when the code it targets has moved. A DSH upgrade reverts them; this
 * script is how they come back.
 *
 * Usage:
 *   node patches/apply.mjs            apply what is missing
 *   node patches/apply.mjs --check    report only, change nothing
 *   node patches/apply.mjs --root DIR look under DIR for the packages
 *   node patches/apply.mjs --revert   undo the patches, where the text still matches
 */
import { readFile, writeFile, mkdtemp, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const run = promisify(execFile)
const here = dirname(new URL(import.meta.url).pathname)

/** Where the built packages live, most specific first. */
async function roots(explicit) {
  const candidates = []
  if (explicit !== undefined) candidates.push(explicit)
  const home = process.env.HOME ?? ''
  const dshHome = process.env.DSH_HOME ?? join(home, '.dsh')
  // A profile's own node_modules, then the pnpm store the harness is installed in.
  candidates.push(join(dshHome, 'profiles'))
  candidates.push(join(home, 'Library/pnpm/global'))
  const found = []
  for (const candidate of candidates) {
    try {
      await stat(candidate)
      found.push(candidate)
    } catch {
      // A root that is not there is simply not searched.
    }
  }
  return found
}

/**
 * Every directory that could hold one package.
 *
 * Two layouts have to be covered: a profile's own `node_modules`, and the pnpm
 * store the harness itself is installed in — which nests `v11/<hash>/node_modules`
 * before `.pnpm`, and keeps several of those side by side, so the search walks to
 * find them rather than assuming a shape.
 * @param root - a directory to search under.
 * @param name - the package name, scope included.
 * @returns every candidate package directory.
 */
async function candidatesFor(root, name) {
  const out = []
  const isDir = async (path) => {
    try {
      return (await stat(path)).isDirectory()
    } catch {
      return false
    }
  }
  const push = async (path) => {
    if (await isDir(path)) out.push(path)
  }
  await push(join(root, 'node_modules', name))
  for (const entry of await readdir(root).catch(() => [])) {
    await push(join(root, entry, 'node_modules', name))
  }
  const walk = async (path, depth) => {
    if (depth === 0) return
    const store = join(path, 'node_modules/.pnpm')
    if (await isDir(store)) {
      // A store entry is `<scope>+<basename>@<version>`, so the scope keeps its
      // leading `@` and loses only the slash.
      const [scope, basename] = name.split('/')
      if (basename !== undefined && scope !== undefined) {
        const prefix = `${scope}+${basename}@`
        for (const entry of await readdir(store).catch(() => [])) {
          if (!entry.startsWith(prefix)) continue
          await push(join(store, entry, 'node_modules', name))
        }
      }
    }
    for (const entry of await readdir(path).catch(() => [])) {
      if (entry === 'node_modules') continue
      const child = join(path, entry)
      if (await isDir(child)) await walk(child, depth - 1)
    }
  }
  await walk(root, 3)
  return out
}

/**
 * Parse a patched file to prove it is still valid JavaScript.
 *
 * Checked through a `.mjs` copy, because `node --check` reads a `.js` file as
 * CommonJS unless a package says otherwise.
 * @param file - the file just written.
 * @returns nothing; throws when the file does not parse.
 */
async function verifyParses(file) {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-patch-check-'))
  const copy = join(scratch, 'check.mjs')
  try {
    await writeFile(copy, await readFile(file))
    await run(process.execPath, ['--check', copy])
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

const patches = []
for (const entry of (await readdir(here)).sort()) {
  if (!entry.endsWith('.mjs') || entry === 'apply.mjs') continue
  patches.push((await import(pathToFileURL(join(here, entry)).href)).default)
}

const argv = process.argv.slice(2)
const check = argv.includes('--check')
const revert = argv.includes('--revert')
const rootArg = argv.indexOf('--root')
const searchRoots = await roots(rootArg === -1 ? undefined : argv[rootArg + 1])
if (searchRoots.length === 0) {
  console.error('no search root found; pass --root')
  process.exit(2)
}

let failed = 0
for (const patch of patches) {
  const dirs = (await Promise.all(searchRoots.map(root => candidatesFor(root, patch.package)))).flat()
  if (dirs.length === 0) {
    console.error(`✖ ${patch.id}: ${patch.package} not found under ${searchRoots.join(', ')}`)
    failed += 1
    continue
  }
  for (const dir of dirs) {
    const file = join(dir, patch.file)
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    let next = text
    let state = 'already applied'
    for (const { find, replace } of patch.replacements) {
      const from = revert ? replace : find
      const to = revert ? find : replace
      // The target is already in place — checked first, because a find string can be
      // a prefix of its own replacement and match both ways.
      if (next.includes(to)) continue
      const count = next.split(from).length - 1
      if (count === 0) {
        // Nothing to do only when the other side is already there. Otherwise the
        // code has moved and this patch no longer knows what it is editing — which
        // is exactly the case that must not pass quietly.
        console.error(`✖ ${patch.id}: the code this replacement targets is gone from ${file}`)
        state = 'refused'
        failed += 1
        break
      }
      if (count > 1) {
        console.error(`✖ ${patch.id}: ${count} matches for a replacement in ${file}; refusing to guess`)
        failed += 1
        state = 'refused'
        break
      }
      state = check ? 'would change' : 'changed'
      next = next.replace(from, to)
    }
    if (state === 'refused') continue
    if (state === 'already applied') {
      console.log(`· ${patch.id}: already applied (${dir})`)
      continue
    }
    if (check) {
      console.log(`· ${patch.id}: would change ${file}`)
      continue
    }
    await writeFile(file, next)
    await verifyParses(file)
    console.log(`✔ ${patch.id}: ${state} — ${patch.summary}`)
  }
}
process.exit(failed === 0 ? 0 : 1)
