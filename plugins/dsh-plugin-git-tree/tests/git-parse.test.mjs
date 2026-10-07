/**
 * Recorded-output tests for the two git parsers.
 *
 * The fixtures are literal bytes from the commands this plugin runs, captured on
 * a repository holding a renamed file, a binary modification, an untracked file,
 * and a staged deletion — every branch of both walkers.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  kindFromPorcelain, parseGitlinks, parseNumstat, parsePorcelainStatus,
} from '../lib/testing/host-git.js'

test('porcelain status folds both columns into one kind', () => {
  assert.deepEqual(kindFromPorcelain('??'), { kind: 'untracked', staged: false })
  assert.deepEqual(kindFromPorcelain('A '), { kind: 'added', staged: true })
  assert.deepEqual(kindFromPorcelain(' M'), { kind: 'modified', staged: false })
  assert.deepEqual(kindFromPorcelain('MM'), { kind: 'modified', staged: true })
  assert.deepEqual(kindFromPorcelain('R '), { kind: 'renamed', staged: true })
  assert.deepEqual(kindFromPorcelain('C '), { kind: 'copied', staged: true })
  assert.deepEqual(kindFromPorcelain(' D'), { kind: 'deleted', staged: false })
  assert.deepEqual(kindFromPorcelain('UU'), { kind: 'conflicted', staged: true })
  assert.deepEqual(kindFromPorcelain('T '), { kind: 'modified', staged: true })
})

test('porcelain status reads rename records and their extra field', () => {
  const stdout = [
    ' D root.txt',
    ' M sub/bin.dat',
    'R  sub/renamed.txt',
    'sub/rename-me.txt',
    ' M sub/tracked.txt',
    '?? sub/untracked.txt',
    '',
  ].join('\0')
  assert.deepEqual(parsePorcelainStatus(stdout), [
    { path: 'root.txt', oldPath: undefined, kind: 'deleted', staged: false },
    { path: 'sub/bin.dat', oldPath: undefined, kind: 'modified', staged: false },
    { path: 'sub/renamed.txt', oldPath: 'sub/rename-me.txt', kind: 'renamed', staged: true },
    { path: 'sub/tracked.txt', oldPath: undefined, kind: 'modified', staged: false },
    { path: 'sub/untracked.txt', oldPath: undefined, kind: 'untracked', staged: false },
  ])
})

test('numstat reads plain, binary, and rename records', () => {
  const stdout = [
    '0\t1\troot.txt',
    '-\t-\tsub/bin.dat',
    '0\t0\t',
    'sub/rename-me.txt',
    'sub/renamed.txt',
    '2\t1\tsub/tracked.txt',
    '',
  ].join('\0')
  assert.deepEqual(parseNumstat(stdout), [
    { path: 'root.txt', oldPath: undefined, insertions: 0, deletions: 1, binary: false },
    { path: 'sub/bin.dat', oldPath: undefined, insertions: null, deletions: null, binary: true },
    { path: 'sub/renamed.txt', oldPath: 'sub/rename-me.txt', insertions: 0, deletions: 0, binary: false },
    { path: 'sub/tracked.txt', oldPath: undefined, insertions: 2, deletions: 1, binary: false },
  ])
})

test('empty output yields nothing rather than a phantom entry', () => {
  assert.deepEqual(parsePorcelainStatus(''), [])
  assert.deepEqual(parseNumstat(''), [])
  assert.deepEqual(parseNumstat('\0\0'), [])
})

test('only the gitlink is read as a submodule', () => {
  // Recorded from a repository with a modified file and a moved submodule: the
  // modes are what distinguish them — 160000 is a commit of another repository.
  const raw = ':100644 100644 6d2abcd 0000000 M\u0000outer.txt\u0000'
    + ':160000 160000 eaa11d8 0000000 M\u0000sub\u0000'
  assert.deepEqual([...parseGitlinks(raw)], ['sub'])
})

test('a newly added or removed submodule is still a submodule', () => {
  // Either side of the entry can carry the mode: an add starts at 000000.
  const added = ':000000 160000 0000000 eaa11d8 A\u0000sub\u0000'
  const removed = ':160000 000000 eaa11d8 0000000 D\u0000sub\u0000'
  assert.deepEqual([...parseGitlinks(added)], ['sub'])
  assert.deepEqual([...parseGitlinks(removed)], ['sub'])
})

test('an ordinary change and an empty diff carry no submodule', () => {
  assert.deepEqual([...parseGitlinks(':100644 100644 6d2abcd 0000000 M\u0000outer.txt\u0000')], [])
  assert.deepEqual([...parseGitlinks('')], [])
})
