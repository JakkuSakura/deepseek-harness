/**
 * Guard rails for the patch set.
 *
 * These patches edit DSH's own build artefacts, so they cannot be exercised here —
 * the packages live wherever the harness is installed. What can be checked is that
 * each one is well formed and specific: a replacement that is not a change, or a
 * find string that is its own replacement, would either do nothing or apply twice.
 * `node patches/apply.mjs` is what proves they still match the installed build.
 */
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { test } from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const here = new URL('../patches/', import.meta.url).pathname

async function load() {
  const out = []
  for (const entry of (await readdir(here)).sort()) {
    if (!entry.endsWith('.mjs') || entry === 'apply.mjs') continue
    out.push((await import(pathToFileURL(join(here, entry)).href)).default)
  }
  return out
}

test('every patch names a package, a file, and at least one change', async () => {
  const patches = await load()
  assert.ok(patches.length > 0, 'no patches found')
  for (const patch of patches) {
    assert.ok(patch.id, 'a patch has no id')
    assert.ok(patch.package?.startsWith('@deepseek-ai/'), `${patch.id}: package is not scoped`)
    assert.ok(patch.file?.startsWith('lib/'), `${patch.id}: file is not under lib/`)
    assert.ok(patch.replacements.length > 0, `${patch.id}: no replacements`)
  }
})

test('every replacement actually changes something, and only once', async () => {
  for (const patch of await load()) {
    for (const { find, replace } of patch.replacements) {
      assert.notEqual(find, replace, `${patch.id}: a replacement is not a change`)
      assert.ok(find.length > 0, `${patch.id}: empty find`)
      assert.ok(replace.length > 0, `${patch.id}: empty replace`)
      // A find string that is a prefix of its replacement matches both ways, which is
      // how one copy of a patch got applied twice before the harness checked order.
      assert.ok(
        !replace.includes(find),
        `${patch.id}: the replacement contains its own find string, so applying is not idempotent`,
      )
    }
  }
})

test('patch ids are unique', async () => {
  const ids = (await load()).map(patch => patch.id)
  assert.equal(new Set(ids).size, ids.length, `duplicate patch id in ${ids.join(', ')}`)
})
