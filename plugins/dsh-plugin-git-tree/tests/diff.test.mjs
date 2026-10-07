/**
 * The diff tab's pure half: the address grammar and the line classification.
 *
 * The address is the shared file grammar under another URI host, so the cases
 * that matter are the ones the file grammar already had to survive — a `#`, a
 * `?`, a space, a non-ASCII name — plus the ones this protocol adds: a
 * foreign address, and one whose scope is not a Session.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GIT_DIFF_PROTOCOL,
  diffLines,
  gitDiffAddress,
  parseGitDiffAddress,
  splitRows,
  titleOfDiffAddress,
  unreadableDiff,
} from '../lib/testing/client-diff.js'

test('a diff address round-trips a Session and a path', () => {
  const address = gitDiffAddress('session-1', 'src/lib/a.ts')
  assert.equal(address, 'dsh-resource://gitdiff/session/session-1/src/lib/a.ts')
  assert.deepEqual(parseGitDiffAddress(address), { sessionId: 'session-1', path: 'src/lib/a.ts' })
})

test('a path that needs encoding survives the round trip', () => {
  const path = 'dir with space/ünïcode#1?.ts'
  const parsed = parseGitDiffAddress(gitDiffAddress('s', path))
  assert.equal(parsed?.path, path)
})

test('an address this plugin does not own is refused rather than guessed at', () => {
  // The file protocol is the same grammar under another host: not ours to read.
  assert.equal(parseGitDiffAddress('dsh-resource://file/session/s/a.ts'), null)
  assert.equal(parseGitDiffAddress('dsh-resource://gitdiff/absolute/etc/hosts'), null)
  assert.equal(parseGitDiffAddress('sidebar://guide'), null)
  assert.equal(parseGitDiffAddress(''), null)
})

test('the chip names the file, and never the whole address', () => {
  assert.equal(titleOfDiffAddress(gitDiffAddress('s', 'src/a.ts')), 'a.ts')
  assert.equal(titleOfDiffAddress(gitDiffAddress('s', 'a.ts')), 'a.ts')
  assert.equal(titleOfDiffAddress('sidebar://guide'), GIT_DIFF_PROTOCOL)
})

test('a failed read is a value, not a throw', () => {
  const value = unreadableDiff('a.ts', 'transport', 'network down')
  assert.deepEqual(value, {
    path: 'a.ts', diff: '', truncated: false, untracked: false,
    failure: { code: 'transport', message: 'network down' },
  })
})

test('diff lines are classified by the marker that opens them', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    'index 111..222 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,3 +1,4 @@',
    ' const a = 1',
    '-const b = 2',
    '+const b = 3',
    '+const c = 4',
    '\\ No newline at end of file',
  ].join('\n')
  assert.deepEqual(diffLines(diff).map(line => line.kind), [
    'file', 'meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add', 'add', 'nonewline',
  ])
})

test('a file header is not mistaken for added or removed content', () => {
  // `+++` and `---` open with the content markers, and only their position in the
  // diff distinguishes them.
  assert.equal(diffLines('--- a/x\n+++ b/x')[0].kind, 'meta')
  assert.equal(diffLines('--- a/x\n+++ b/x')[1].kind, 'meta')
  assert.equal(diffLines('+added')[0].kind, 'add')
  assert.equal(diffLines('-removed')[0].kind, 'del')
})

test('an empty diff has no lines rather than one blank one', () => {
  assert.deepEqual(diffLines(''), [])
  assert.equal(diffLines('+one\n').length, 1)
  assert.equal(diffLines('+one').length, 1)
})

test('a binary change is drawn as metadata, not as lines', () => {
  const lines = diffLines('diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ')
  assert.deepEqual(lines.map(line => line.kind), ['file', 'meta'])
})

test('a removal and its replacement share one row, left and right', () => {
  const rows = splitRows('@@ -1 +1 @@\n-const b = 2\n+const b = 3\n')
  assert.deepEqual(rows.map(row => row.kind), ['hunk', 'pair'])
  assert.equal(rows[1].left.text, '-const b = 2')
  assert.equal(rows[1].right.text, '+const b = 3')
})

test('a run of removals pairs with the run of additions that answers it', () => {
  const rows = splitRows('-a\n-b\n+A\n+B\n')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].left.text, '-a')
  assert.equal(rows[0].right.text, '+A')
  assert.equal(rows[1].left.text, '-b')
  assert.equal(rows[1].right.text, '+B')
})

test('runs of unequal length leave the shorter side blank rather than shifting', () => {
  // One removal, two additions: the second addition has nothing to pair with, and
  // the first must not slide across to meet it.
  const removedOne = splitRows('-a\n+A\n+B\n')
  assert.equal(removedOne.length, 2)
  assert.equal(removedOne[0].left.text, '-a')
  assert.equal(removedOne[0].right.text, '+A')
  assert.equal(removedOne[1].left, null)
  assert.equal(removedOne[1].right.text, '+B')

  const addedTwo = splitRows('-a\n-b\n+A\n')
  assert.equal(addedTwo.length, 2)
  assert.equal(addedTwo[1].right, null)
  assert.equal(addedTwo[1].left.text, '-b')
})

test('an addition with no removal ahead of it stands alone on the right', () => {
  const rows = splitRows(' context\n+brand new\n')
  assert.equal(rows[0].kind, 'pair')
  assert.equal(rows[0].left.text, ' context')
  assert.equal(rows[0].right.text, ' context')
  assert.equal(rows[1].left, null)
  assert.equal(rows[1].right.text, '+brand new')
})

test('headers span both columns instead of being split', () => {
  const rows = splitRows('diff --git a/a.ts b/a.ts\nindex 111..222 100644\n@@ -1 +1 @@\n-x\n+y\n')
  assert.deepEqual(rows.map(row => row.kind), ['file', 'meta', 'hunk', 'pair'])
  assert.equal(rows[0].text, 'diff --git a/a.ts b/a.ts')
  assert.equal(rows[2].text, '@@ -1 +1 @@')
  assert.equal(rows[0].left, null)
})

test('an empty diff has no rows', () => {
  assert.deepEqual(splitRows(''), [])
})
