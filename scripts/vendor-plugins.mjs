#!/usr/bin/env node
// Refresh the local plugin mirror from its authoring checkout.
//
// The plugin sources live outside this repository, in `AgentControl/dsh-plugins`. That
// tree stays the single copy: the Web profile links the plugins from there, and this
// repository neither carries nor installs them. This hook only keeps the vendored
// `dsh-plugin-git-tree` in step with the SakuraLens authoring checkout, which is the
// reason it used to exist inside the repository.
//
// The work itself belongs to `dsh-plugins/vendor.sh`, the same script AgentControl's
// `just dsh-plugins-vendor` runs, so the two entry points cannot diverge. This module
// locates that script and delegates to it.
//
// A checkout without the sibling `AgentControl/dsh-plugins` — CI, a fresh clone, a
// machine that runs the published packages — installs normally and skips with a note.
// `DSH_PLUGIN_LOCAL_ROOT` names the plugin tree explicitly when it lives elsewhere.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
// Two layouts reach this checkout: a standalone clone beside AgentControl, or AgentControl's
// own submodule, where the plugin tree is a sibling inside AgentControl rather than beside it.
const candidates = [
  resolve(repositoryRoot, '..', 'AgentControl', 'dsh-plugins'),
  resolve(repositoryRoot, '..', 'dsh-plugins'),
]
const pluginRoot = process.env.DSH_PLUGIN_LOCAL_ROOT ?? candidates.find(root => existsSync(resolve(root, 'vendor.sh')))
const vendor = pluginRoot === undefined ? undefined : resolve(pluginRoot, 'vendor.sh')

if (vendor === undefined) {
  console.log(`vendor-plugins: no plugin tree beside ${repositoryRoot} — skipping the local plugin mirror`)
  process.exit(0)
}

const result = spawnSync('bash', [vendor], { stdio: 'inherit' })
if (result.error !== undefined) throw result.error
process.exit(result.status ?? 0)
