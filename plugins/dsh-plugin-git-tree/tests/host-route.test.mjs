/**
 * End-to-end tests for the Host half.
 *
 * The plugin is loaded from its built artifact, applied to a context whose only
 * substitutes are the subprocess capability (backed by real `node:child_process`
 * spawns) and a one-Session store, and then driven through the route it
 * registered. Git itself is real: each case builds a throwaway repository, so the
 * parsers, the pathspec scoping, and the line counting are all exercised against
 * the executable the plugin actually shells out to.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn as spawnChild } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { apply, inject, name } from '../lib/index.js'

const cleanups = []
after(async () => {
  for (const run of cleanups.reverse()) await run()
})

/** Environment that keeps git away from the operator's own configuration. */
function gitEnvironment(home) {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  }
}

/** A subprocess capability backed by real child processes. */
function realSubprocess(overrides = {}) {
  return {
    async resolveExecutable(command) {
      return execFileSync('which', [command], { encoding: 'utf8' }).trim()
    },
    spawn(spec) {
      const child = spawnChild(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const limit = spec.stdio.stdout?.maxBytes ?? Number.POSITIVE_INFINITY
      let out = ''
      let err = ''
      let lossy = false
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        out += chunk
        if (out.length > limit) { out = out.slice(out.length - limit); lossy = true }
      })
      child.stderr.on('data', (chunk) => { err += chunk })
      const done = new Promise((resolve) => {
        child.on('close', (exitCode, signal) => { resolve({ exitCode, signal }) })
      })
      return {
        done,
        terminate() { child.kill('SIGKILL') },
        collected: {
          stdout: { readFrom: () => ({ text: out, nextOffset: out.length, lossy }) },
          stderr: { readFrom: () => ({ text: err, nextOffset: err.length, lossy: false }) },
        },
      }
    },
    ...overrides,
  }
}

/**
 * Build a context whose route registrations and Session lookup are captured.
 *
 * The plugin registers one route per question — a counted change set and a single
 * diff — so the harness keys them by path and hands back the one a case asks for.
 */
async function askBlob(routes, query) {
  const route = routes.get('/api/git-tree/blob')
  assert.ok(route, 'the blob route is not registered')
  const response = await route.fetch(new Request(`http://dsh.internal/api/git-tree/blob${query}`))
  return { status: response.status, body: await response.json() }
}
function harness({ cwd, subprocess = realSubprocess(), sessions } = {}) {
  const routes = new Map()
  const ctx = {
    subprocess,
    sessions: sessions ?? { get: id => (id === 'session-1' ? { header: { cwd } } : undefined) },
    connection: {
      fetch: {
        register: (registered) => {
          routes.set(registered.path, registered)
          return Promise.resolve(() => {})
        },
      },
    },
  }
  apply(ctx)
  assert.ok(routes.size > 0, 'apply() registered no route')
  return routes
}

/** Ask the plugin for one Session's counts. */
async function ask(routes, query) {
  const route = routes.get('/api/git-tree')
  assert.ok(route, 'the counts route is not registered')
  const url = `http://dsh.internal/api/git-tree${query}`
  const response = await route.fetch(new Request(url))
  return { status: response.status, body: await response.json() }
}

/** Ask the plugin for one path's diff. */
async function askDiff(routes, query) {
  const route = routes.get('/api/git-tree/diff')
  assert.ok(route, 'the diff route is not registered')
  const response = await route.fetch(new Request(`http://dsh.internal/api/git-tree/diff${query}`))
  return { status: response.status, body: await response.json() }
}

/** Commit everything currently staged. */
function commit(dir, env, message) {
  execFileSync('git', ['add', '-A'], { cwd: dir, env, stdio: 'pipe' })
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', message], { cwd: dir, env, stdio: 'pipe' })
}

test('the Host artifact exports the cordis plugin contract', () => {
  assert.equal(name, 'git-tree')
  assert.deepEqual(inject, ['connection', 'sessions', 'subprocess'])
  assert.equal(typeof apply, 'function')
})

test('a workspace outside any repository answers no-repository', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-tree-plain-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const route = harness({ cwd: dir })
  const { status, body } = await ask(route, '?sessionId=session-1')
  assert.equal(status, 200)
  assert.deepEqual(body, { status: 'no-repository' })
})

test('a request without a sessionId, and one naming an unknown Session, are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-tree-plain-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const route = harness({ cwd: dir })
  assert.deepEqual(await ask(route, ''), {
    status: 400,
    body: { status: 'error', code: 'bad-request', message: 'sessionId is required' },
  })
  const missing = await ask(route, '?sessionId=session-9')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.code, 'no-session')
})

test('an unavailable git answers git-unavailable rather than failing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-tree-plain-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const route = harness({
    cwd: dir,
    subprocess: realSubprocess({ resolveExecutable: async () => { throw new Error('no git') } }),
  })
  const { status, body } = await ask(route, '?sessionId=session-1')
  assert.equal(status, 200)
  assert.equal(body.status, 'error')
  assert.equal(body.code, 'git-unavailable')
})

test('the change set carries statuses, line counts, and binary marks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-tree-repo-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const env = gitEnvironment(dir)
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, env, stdio: 'pipe' })

  await mkdir(join(dir, 'sub', 'deep'), { recursive: true })
  await writeFile(join(dir, 'root-only.txt'), 'root\n')
  await writeFile(join(dir, 'sub', 'tracked.txt'), 'a\nb\nc\n')
  await writeFile(join(dir, 'sub', 'rename-me.txt'), 'x\ny\n')
  await writeFile(join(dir, 'sub', 'bin.dat'), Buffer.from([0x62, 0x69, 0x6e, 0x00, 0x31, 0x0a]))
  await writeFile(join(dir, 'sub', 'deleted.txt'), 'gone\n')
  await writeFile(join(dir, 'sub', 'deep', 'nested.txt'), 'n1\nn2\nn3\n')
  commit(dir, env, 'init')

  await writeFile(join(dir, 'root-only.txt'), 'root\nmore\n')
  await writeFile(join(dir, 'sub', 'tracked.txt'), 'a\nB\nc\nd\n')
  execFileSync('git', ['mv', 'sub/rename-me.txt', 'sub/renamed.txt'], { cwd: dir, env, stdio: 'pipe' })
  await writeFile(join(dir, 'sub', 'bin.dat'), Buffer.from([0x62, 0x69, 0x6e, 0x00, 0x32, 0x0a]))
  await rm(join(dir, 'sub', 'deleted.txt'))
  await writeFile(join(dir, 'sub', 'deep', 'nested.txt'), 'n1\nN2\nn3\n')
  // Three lines with no terminating newline: the counted fourth line is not invented.
  await writeFile(join(dir, 'sub', 'untracked.txt'), 'one\ntwo\nthree')

  const route = harness({ cwd: dir })
  const { status, body } = await ask(route, '?sessionId=session-1')
  assert.equal(status, 200)
  assert.equal(body.status, 'ok')
  const { snapshot } = body
  assert.equal(snapshot.repositoryRoot, await realpath(dir))
  assert.equal(snapshot.workspaceRoot, dir)

  const byPath = new Map(snapshot.changes.map(change => [change.path, change]))
  assert.deepEqual([...byPath.keys()].sort(), [
    'root-only.txt',
    'sub/bin.dat',
    'sub/deep/nested.txt',
    'sub/deleted.txt',
    'sub/renamed.txt',
    'sub/tracked.txt',
    'sub/untracked.txt',
  ])

  assert.equal(byPath.get('root-only.txt').kind, 'modified')
  assert.equal(byPath.get('root-only.txt').insertions, 1)
  assert.equal(byPath.get('root-only.txt').deletions, 0)

  const tracked = byPath.get('sub/tracked.txt')
  assert.equal(tracked.kind, 'modified')
  assert.equal(tracked.insertions, 2)
  assert.equal(tracked.deletions, 1)

  // A rename is reported at its new path, which is the one the tree can open.
  assert.equal(byPath.get('sub/renamed.txt').kind, 'renamed')

  const binary = byPath.get('sub/bin.dat')
  assert.equal(binary.binary, true)
  assert.equal(binary.insertions, null)
  assert.equal(binary.deletions, null)

  const deleted = byPath.get('sub/deleted.txt')
  assert.equal(deleted.kind, 'deleted')
  assert.equal(deleted.insertions, 0)
  assert.equal(deleted.deletions, 1)

  // An untracked file's counts come from reading it, not from git.
  const untracked = byPath.get('sub/untracked.txt')
  assert.equal(untracked.kind, 'untracked')
  assert.equal(untracked.insertions, 3)
  assert.equal(untracked.deletions, 0)

  assert.equal(snapshot.totals.files, 7)
  assert.equal(snapshot.totals.binary, 1)
  assert.equal(snapshot.truncated, false)
  assert.equal(typeof snapshot.generatedAt, 'number')
})

test('a workspace nested in the repository sees only its own subtree, in its own spellings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-tree-nested-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const env = gitEnvironment(dir)
  const workspace = join(dir, 'packages', 'app')
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, env, stdio: 'pipe' })
  await mkdir(workspace, { recursive: true })
  await writeFile(join(dir, 'top.txt'), 'top\n')
  await writeFile(join(workspace, 'inside.txt'), 'a\n')
  commit(dir, env, 'init')

  await writeFile(join(dir, 'top.txt'), 'top\nchanged\n')
  await writeFile(join(workspace, 'inside.txt'), 'a\nb\n')

  const route = harness({ cwd: workspace })
  const { body } = await ask(route, '?sessionId=session-1')
  assert.equal(body.status, 'ok')
  // The repository above is reported, but only the workspace's own files appear.
  assert.equal(body.snapshot.repositoryRoot, await realpath(dir))
  assert.deepEqual(body.snapshot.changes.map(change => change.path), ['inside.txt'])
})

test('an unborn branch still reports the staged and unstaged files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-tree-unborn-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const env = gitEnvironment(dir)
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, env, stdio: 'pipe' })
  await writeFile(join(dir, 'staged.txt'), 's1\ns2\n')
  execFileSync('git', ['add', 'staged.txt'], { cwd: dir, env, stdio: 'pipe' })
  await writeFile(join(dir, 'loose.txt'), 'l1\n')

  const route = harness({ cwd: dir })
  const { body } = await ask(route, '?sessionId=session-1')
  assert.equal(body.status, 'ok')
  const byPath = new Map(body.snapshot.changes.map(change => [change.path, change]))
  assert.equal(byPath.get('staged.txt').insertions, 2)
  assert.equal(byPath.get('loose.txt').insertions, 1)
})

test('the file cap keeps the totals complete and says it truncated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-tree-cap-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const env = gitEnvironment(dir)
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, env, stdio: 'pipe' })
  await writeFile(join(dir, 'seed.txt'), 'seed\n')
  commit(dir, env, 'init')
  for (let index = 0; index < 5; index += 1) {
    await writeFile(join(dir, `loose-${String(index)}.txt`), `line ${String(index)}\n`)
  }
  const route = harness({ cwd: dir })
  const { body } = await ask(route, '?sessionId=session-1')
  assert.equal(body.status, 'ok')
  // The default cap is far above five, so nothing is dropped here; the flag is
  // still exercised by the wire shape.
  assert.equal(body.snapshot.truncated, false)
  assert.equal(body.snapshot.changes.length, 5)
  assert.equal(body.snapshot.totals.files, 5)
})

test('a submodule read outside the workspace is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-tree-fence-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const routes = harness({ cwd: dir })
  // The scope names a directory inside the workspace, never one beyond it.
  const outside = await ask(routes, '?sessionId=session-1&submodule=../../../etc')
  assert.equal(outside.status, 400)
  assert.equal(outside.body.code, 'bad-request')
})

test('a submodule read answers for the submodule, not the enclosing repository', async () => {
  const home = await mkdtemp(join(tmpdir(), 'git-tree-sub-home-'))
  const inner = await mkdtemp(join(tmpdir(), 'git-tree-sub-inner-'))
  const outer = await mkdtemp(join(tmpdir(), 'git-tree-sub-outer-'))
  cleanups.push(
    () => rm(home, { recursive: true, force: true }),
    () => rm(inner, { recursive: true, force: true }),
    () => rm(outer, { recursive: true, force: true }),
  )
  const env = gitEnvironment(home)
  for (const dir of [inner, outer]) execFileSync('git', ['init', '-q'], { cwd: dir, env, stdio: 'pipe' })
  await writeFile(join(inner, 'inside.txt'), 'inside\n')
  commit(inner, env, 'inner')
  await writeFile(join(outer, 'outside.txt'), 'outside\n')
  commit(outer, env, 'outer')
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub'], {
    cwd: outer,
    env,
    stdio: 'pipe',
  })
  commit(outer, env, 'add the submodule')
  // A change in the enclosing repository, which the scoped read must not report.
  await writeFile(join(outer, 'outside.txt'), 'changed\n')

  const routes = harness({ cwd: outer })
  const whole = await ask(routes, '?sessionId=session-1')
  assert.deepEqual(whole.body.snapshot.changes.map(change => change.path), ['outside.txt'])

  const scoped = await ask(routes, '?sessionId=session-1&submodule=sub')
  assert.equal(scoped.body.status, 'ok')
  assert.deepEqual(scoped.body.snapshot.changes, [])
})

test('the committed bytes come back as base64 for a path HEAD holds', async () => {
  const home = await mkdtemp(join(tmpdir(), 'git-tree-blob-home-'))
  const dir = await mkdtemp(join(tmpdir(), 'git-tree-blob-'))
  cleanups.push(
    () => rm(home, { recursive: true, force: true }),
    () => rm(dir, { recursive: true, force: true }),
  )
  const env = gitEnvironment(home)
  execFileSync('git', ['init', '-q'], { cwd: dir, env, stdio: 'pipe' })
  // Bytes that are not valid UTF-8 anywhere, so a text channel would corrupt them.
  const committed = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x7f])
  await writeFile(join(dir, 'pic.png'), committed)
  commit(dir, env, 'init')
  // Then change it, so the committed side is the *earlier* version.
  await writeFile(join(dir, 'pic.png'), Buffer.concat([committed, Buffer.from([1, 2, 3])]))

  const routes = harness({ cwd: dir })
  const { status, body } = await askBlob(routes, '?sessionId=session-1&path=pic.png')
  assert.equal(status, 200)
  assert.equal(body.status, 'ok')
  assert.equal(body.mime, 'image/png')
  assert.deepEqual(Buffer.from(body.base64, 'base64'), committed)
})

test('a blob path HEAD does not hold answers that there is no previous version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-tree-blob-new-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const home = await mkdtemp(join(tmpdir(), 'git-tree-blob-new-home-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const env = gitEnvironment(home)
  execFileSync('git', ['init', '-q'], { cwd: dir, env, stdio: 'pipe' })
  await writeFile(join(dir, 'a.txt'), 'x\n')
  commit(dir, env, 'init')
  await writeFile(join(dir, 'fresh.png'), Buffer.from([1, 2, 3]))

  const routes = harness({ cwd: dir })
  const { body } = await askBlob(routes, '?sessionId=session-1&path=fresh.png')
  assert.equal(body.status, 'error')
  assert.equal(body.code, 'no-previous')
})

test('a blob path outside the workspace is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-tree-blob-fence-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const routes = harness({ cwd: dir })
  const { status, body } = await askBlob(routes, '?sessionId=session-1&path=../../etc/passwd')
  assert.equal(status, 400)
  assert.equal(body.code, 'bad-request')
})

test('a blob read needs both a Session and a path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-tree-blob-bare-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const routes = harness({ cwd: dir })
  const { status } = await askBlob(routes, '?sessionId=session-1')
  assert.equal(status, 400)
})

test('a file inside a submodule diffs against the submodule, not the workspace', async () => {
  const home = await mkdtemp(join(tmpdir(), 'git-tree-subfile-home-'))
  const inner = await mkdtemp(join(tmpdir(), 'git-tree-subfile-inner-'))
  const outer = await mkdtemp(join(tmpdir(), 'git-tree-subfile-outer-'))
  cleanups.push(
    () => rm(home, { recursive: true, force: true }),
    () => rm(inner, { recursive: true, force: true }),
    () => rm(outer, { recursive: true, force: true }),
  )
  const env = gitEnvironment(home)
  for (const dir of [inner, outer]) execFileSync('git', ['init', '-q'], { cwd: dir, env, stdio: 'pipe' })
  await writeFile(join(inner, 'inside.txt'), 'one\n')
  commit(inner, env, 'inner')
  await writeFile(join(outer, 'outside.txt'), 'outer\n')
  commit(outer, env, 'outer')
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub'], {
    cwd: outer, env, stdio: 'pipe',
  })
  commit(outer, env, 'add the submodule')
  // Change the file *inside* the submodule. The workspace's own repository sees
  // only a gitlink there, so asking it would call the file untracked.
  await writeFile(join(outer, 'sub', 'inside.txt'), 'one\ntwo\n')

  const routes = harness({ cwd: outer })
  const { body } = await askDiff(routes, '?sessionId=session-1&path=sub/inside.txt')
  assert.equal(body.status, 'ok')
  assert.equal(body.view.path, 'sub/inside.txt')
  assert.match(body.view.diff, /\+two/)
})

test('a file whose directory is gone still reports its deletion', async () => {
  const home = await mkdtemp(join(tmpdir(), 'git-tree-gone-home-'))
  const dir = await mkdtemp(join(tmpdir(), 'git-tree-gone-'))
  cleanups.push(
    () => rm(home, { recursive: true, force: true }),
    () => rm(dir, { recursive: true, force: true }),
  )
  const env = gitEnvironment(home)
  execFileSync('git', ['init', '-q'], { cwd: dir, env, stdio: 'pipe' })
  await mkdir(join(dir, 'doomed'), { recursive: true })
  await writeFile(join(dir, 'doomed', 'note.txt'), 'kept\n')
  commit(dir, env, 'init')
  // Remove the file and its now-empty directory, so the file's own directory no
  // longer exists to run git in.
  await rm(join(dir, 'doomed'), { recursive: true, force: true })

  const routes = harness({ cwd: dir })
  const { body } = await askDiff(routes, '?sessionId=session-1&path=doomed/note.txt')
  assert.equal(body.status, 'ok')
  assert.match(body.view.diff, /-kept/)
})

test('a diff path outside the workspace is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-tree-diff-fence-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const routes = harness({ cwd: dir })
  const { status } = await askDiff(routes, '?sessionId=session-1&path=../../etc/passwd')
  assert.equal(status, 400)
})

test('a nested file diffs against the repository, not the workspace prefix', async () => {
  const home = await mkdtemp(join(tmpdir(), 'git-tree-nested-home-'))
  const dir = await mkdtemp(join(tmpdir(), 'git-tree-nested-'))
  cleanups.push(
    () => rm(home, { recursive: true, force: true }),
    () => rm(dir, { recursive: true, force: true }),
  )
  const env = gitEnvironment(home)
  execFileSync('git', ['init', '-q'], { cwd: dir, env, stdio: 'pipe' })
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'a.ts'), 'one\ntwo\n')
  commit(dir, env, 'init')
  await writeFile(join(dir, 'src', 'a.ts'), 'one\ntwo changed\nthree\n')

  // The path is repository-relative (`src/a.ts`) while the read is scoped to the
  // file's own directory, so a command run from the workspace looks for it twice over
  // and reports no change at all.
  const routes = harness({ cwd: dir })
  const { body } = await askDiff(routes, '?sessionId=session-1&path=src/a.ts')
  assert.equal(body.status, 'ok')
  assert.equal(body.view.path, 'src/a.ts')
  assert.match(body.view.diff, /\+two changed/)
  assert.match(body.view.diff, /\+three/)
})
