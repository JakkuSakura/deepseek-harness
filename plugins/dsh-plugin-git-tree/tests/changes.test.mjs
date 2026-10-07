/**
 * Tests for the browser half's pure folds: path joins, the workspace-relative
 * form, and the change index that attributes counts to directories.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildChangeIndex, changeFolders, childPath, foldChangeTree, orderEntries, parentPath, relativeToRoot, statusLetter,
} from '../lib/testing/client-changes.js'

test('childPath joins without doubling or losing separators', () => {
  assert.equal(childPath('/a/b', 'c.txt'), '/a/b/c.txt')
  assert.equal(childPath('/a/b/', 'c.txt'), '/a/b/c.txt')
  assert.equal(childPath('/', 'c.txt'), '/c.txt')
  assert.equal(childPath('C:\\a', 'c.txt'), 'C:\\a/c.txt')
})

test('relativeToRoot answers the workspace form, including the root itself', () => {
  assert.equal(relativeToRoot('/w', '/w'), '')
  assert.equal(relativeToRoot('/w', '/w/a/b.txt'), 'a/b.txt')
  assert.equal(relativeToRoot('/w/', '/w/a.txt'), 'a.txt')
  assert.equal(relativeToRoot('/w', '/elsewhere/a.txt'), '/elsewhere/a.txt')
})

test('parentPath walks up to the root', () => {
  assert.equal(parentPath('a/b/c.txt'), 'a/b')
  assert.equal(parentPath('a.txt'), '')
  assert.equal(parentPath('a/b'), 'a')
})

test('statusLetter names each kind', () => {
  const letter = kind => statusLetter({ path: 'p', kind, insertions: 0, deletions: 0, binary: false })
  assert.equal(letter('added'), 'A')
  assert.equal(letter('modified'), 'M')
  assert.equal(letter('deleted'), 'D')
  assert.equal(letter('renamed'), 'R')
  assert.equal(letter('copied'), 'C')
  assert.equal(letter('untracked'), 'U')
  assert.equal(letter('conflicted'), '!')
})

test('buildChangeIndex distinguishes loading, no-repository, and error', () => {
  assert.equal(buildChangeIndex(null).status, 'loading')
  assert.equal(buildChangeIndex({ status: 'no-repository' }).status, 'no-repository')
  const failed = buildChangeIndex({ status: 'error', code: 'git-failed', message: 'boom' })
  assert.equal(failed.status, 'error')
  assert.equal(failed.message, 'boom')
  assert.deepEqual(failed.totals, { files: 0, insertions: 0, deletions: 0, binary: 0 })
})

test('buildChangeIndex attributes every change to each directory above it', () => {
  const response = {
    status: 'ok',
    snapshot: {
      repositoryRoot: '/repo',
      workspaceRoot: '/repo',
      changes: [
        { path: 'src/a.ts', kind: 'modified', insertions: 3, deletions: 1, binary: false },
        { path: 'src/deep/b.ts', kind: 'added', insertions: 5, deletions: 0, binary: false },
        { path: 'readme.md', kind: 'modified', insertions: 2, deletions: 2, binary: false },
        { path: 'logo.png', kind: 'modified', insertions: null, deletions: null, binary: true },
      ],
      totals: { files: 4, insertions: 10, deletions: 3, binary: 1 },
      truncated: false,
      generatedAt: 0,
    },
  }
  const index = buildChangeIndex(response)
  assert.equal(index.status, 'ok')
  assert.equal(index.byPath.get('src/a.ts').kind, 'modified')
  assert.deepEqual(index.byDirectory.get(''), { insertions: 10, deletions: 3, files: 4 })
  assert.deepEqual(index.byDirectory.get('src'), { insertions: 8, deletions: 1, files: 2 })
  assert.deepEqual(index.byDirectory.get('src/deep'), { insertions: 5, deletions: 0, files: 1 })
  // A binary change counts as a file but contributes no lines anywhere.
  assert.equal(index.byDirectory.get('logo.png'), undefined)
  assert.equal(index.byDirectory.get('').insertions, 10)
})

test('orderEntries puts directories first, then natural name order', () => {
  const entry = (name, type) => ({ name, type })
  const ordered = orderEntries([
    entry('file10.txt', 'file'),
    entry('zeta', 'directory'),
    entry('file2.txt', 'file'),
    entry('alpha', 'directory'),
    entry('link', 'other'),
  ])
  assert.deepEqual(ordered.map(item => item.name), ['alpha', 'zeta', 'file2.txt', 'file10.txt', 'link'])
  // The input array is not mutated.
  assert.equal(ordered.length, 5)
})

test('foldChangeTree groups changed paths by folder, folders before files', () => {
  const change = (path, insertions, deletions) => ({ path, kind: 'modified', insertions, deletions, binary: false })
  const tree = foldChangeTree([
    change('src/parser/lib.rs', 3, 1),
    change('src/lib.rs', 2, 0),
    change('README.md', 1, 1),
    change('docs/guide/intro.md', 4, 0),
  ])

  // Root level: folders first (docs, src), then files.
  assert.deepEqual(tree.map(node => [node.kind, node.name]), [
    ['directory', 'docs'],
    ['directory', 'src'],
    ['file', 'README.md'],
  ])

  const docs = tree[0]
  assert.equal(docs.path, 'docs')
  // Counts aggregate everything beneath, at every depth.
  assert.deepEqual(docs.counts, { insertions: 4, deletions: 0, files: 1 })
  assert.deepEqual(docs.children.map(node => node.name), ['guide'])
  assert.deepEqual(docs.children[0].path, 'docs/guide')

  const src = tree[1]
  assert.deepEqual(src.counts, { insertions: 5, deletions: 1, files: 2 })
  // A nested folder precedes the file sitting beside it.
  assert.deepEqual(src.children.map(node => [node.kind, node.name]), [
    ['directory', 'parser'],
    ['file', 'lib.rs'],
  ])
  assert.deepEqual(src.children[0].counts, { insertions: 3, deletions: 1, files: 1 })
  assert.equal(src.children[1].path, 'src/lib.rs')
  assert.equal(src.children[1].change.insertions, 2)
})

test('foldChangeTree counts binary leaves as files without inventing lines', () => {
  const tree = foldChangeTree([
    { path: 'assets/logo.png', kind: 'modified', insertions: null, deletions: null, binary: true },
  ])
  assert.deepEqual(tree[0].counts, { insertions: 0, deletions: 0, files: 1 })
})

test('foldChangeTree of nothing is nothing', () => {
  assert.deepEqual(foldChangeTree([]), [])
})

test('changeFolders names every folder a change lives under, shallowest first', () => {
  const change = path => ({ path, kind: 'modified', insertions: 1, deletions: 0, binary: false })
  const folders = changeFolders([
    change('src/parser/deep/lib.rs'),
    change('src/lib.rs'),
    change('README.md'),
  ])
  assert.deepEqual(folders, ['src', 'src/parser', 'src/parser/deep'])
  // A file at the workspace root lives in no folder at all.
  assert.deepEqual(changeFolders([change('README.md')]), [])
})

test('changeFolders bounds how many listings one open may trigger', () => {
  const change = path => ({ path, kind: 'modified', insertions: 1, deletions: 0, binary: false })
  const changes = Array.from({ length: 40 }, (_, index) => change(`src/pkg${String(index)}/lib.rs`))
  assert.equal(changeFolders(changes, 5).length, 5)
})

test('a submodule folds as a marked folder, not as a file', () => {
  // The superproject records a gitlink at a directory path, so the outline shows
  // the folder it is; its change rides along for the mark to read.
  const changes = [
    { path: 'src/a.ts', kind: 'modified', insertions: 2, deletions: 1, binary: false, submodule: false },
    { path: 'sub', kind: 'modified', insertions: null, deletions: null, binary: false, submodule: true },
  ]
  const tree = foldChangeTree(changes)
  const sub = tree.find(node => node.path === 'sub')
  assert.equal(sub.kind, 'directory')
  assert.equal(sub.submodule, true)
  assert.equal(sub.change.kind, 'modified')
  assert.deepEqual(sub.children, [])
  // The folder it is does not make the file beside it anything else.
  const src = tree.find(node => node.path === 'src')
  assert.equal(src.kind, 'directory')
  assert.equal(src.submodule, undefined)
  // The file stays a file, one level down inside its own folder.
  const filesOf = (nodes) => nodes.flatMap(node => node.kind === 'file' ? [node] : filesOf(node.children ?? []))
  assert.deepEqual(filesOf(tree).map(node => node.path), ['src/a.ts'])
})

test('a submodule beside a folder of the same name keeps the folder', () => {
  // Changes never live under a submodule — git reports the gitlink, not its
  // contents — but the fold must not lose a folder if one ever shares the path.
  const changes = [
    { path: 'sub', kind: 'modified', insertions: null, deletions: null, binary: false, submodule: true },
  ]
  const [node] = foldChangeTree(changes)
  assert.equal(node.path, 'sub')
  assert.equal(node.name, 'sub')
})
