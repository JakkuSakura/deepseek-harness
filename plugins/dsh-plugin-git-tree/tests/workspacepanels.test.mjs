/**
 * The per-workspace panel model.
 *
 * The kit keys a right-panel layout by Session, so two Sessions of one Workspace
 * would otherwise hold unrelated tabs. These cases cover the four decisions that
 * turn Session membership into Workspace membership — which tabs a Session holds,
 * which of a remembered set are missing, what can be re-opened at all, and which
 * Workspace a Session belongs to.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  WorkspacePanels, missingTabs, restorableAddress, sessionTabs, workspaceOfSession,
  extraTabs, retargetAddress,
} from '../lib/testing/client-workspacepanels.js'

const entry = (sessionId, contentId, kind = 'git-changes') => ({ sessionId, kind, contentId })

test('a Session reads only its own tabs, in inventory order', () => {
  const all = [
    entry('a', 'dsh-resource://gitdiff/session/a/x.ts'),
    entry('b', 'dsh-resource://file/session/b/y.ts'),
    entry('a', 'dsh-resource://gitdiff/session/a/z.ts'),
  ]
  assert.deepEqual(sessionTabs(all, 'a').map(tab => tab.contentId), [
    'dsh-resource://gitdiff/session/a/x.ts',
    'dsh-resource://gitdiff/session/a/z.ts',
  ])
  assert.deepEqual(sessionTabs(all, 'missing'), [])
})

test('a remembered tab already open is not opened again', () => {
  const remembered = [
    { kind: 'git-changes', contentId: 'dsh-resource://gitdiff/session/a/x.ts' },
    { kind: 'git-changes', contentId: 'dsh-resource://gitdiff/session/a/z.ts' },
  ]
  const open = [{ kind: 'git-changes', contentId: 'dsh-resource://gitdiff/session/a/x.ts' }]
  assert.deepEqual(missingTabs(remembered, open).map(tab => tab.contentId), [
    'dsh-resource://gitdiff/session/a/z.ts',
  ])
})

test('a duplicate in the remembered set opens once', () => {
  const tab = { kind: 'git-changes', contentId: 'dsh-resource://gitdiff/session/a/x.ts' }
  assert.equal(missingTabs([tab, tab], []).length, 1)
})

test('a tab that is not address-backed is dropped, not reopened wrong', () => {
  // A page opened by kind needs that kind's own navigation parameters, which a tab
  // record does not carry.
  assert.equal(restorableAddress({ kind: 'guide', contentId: 'guide' }), undefined)
  assert.equal(restorableAddress({ kind: 'git-changes', contentId: 'sidebar://guide' }), undefined)
  const missing = missingTabs([{ kind: 'guide', contentId: 'guide' }], [])
  assert.deepEqual(missing, [])
})

test('a Session is placed in the Workspace that accounts for it', () => {
  const items = [
    { workspaceId: 'w1', sessionIds: ['s1', 's2'] },
    { workspaceId: 'w2', sessionIds: ['s3'] },
  ]
  assert.equal(workspaceOfSession(items, 's2'), 'w1')
  assert.equal(workspaceOfSession(items, 's3'), 'w2')
  assert.equal(workspaceOfSession(items, 's9'), undefined)
})

test('a Workspace remembers its own set and starts empty', () => {
  const panels = new WorkspacePanels()
  assert.deepEqual(panels.tabs('w1'), [])
  panels.record('w1', [{ kind: 'git-changes', contentId: 'dsh-resource://gitdiff/session/a/x.ts' }])
  assert.equal(panels.tabs('w1').length, 1)
  assert.deepEqual(panels.tabs('w2'), [])
  panels.record('w1', [])
  assert.deepEqual(panels.tabs('w1'), [])
})

test('a remembered address is re-pointed at the Session being entered', () => {
  // Addresses are Session-scoped, so replaying one verbatim opens a resource that
  // belongs to the Session it came from. The path carries over; the id does not.
  const remembered = 'dsh-resource://gitdiff/session/session-a/src/a.rs'
  assert.equal(
    retargetAddress(remembered, 'session-b'),
    'dsh-resource://gitdiff/session/session-b/src/a.rs',
  )
  // Something that is not a session address is left as it is.
  assert.equal(retargetAddress('dsh-resource://file/other/x', 'session-b'), 'dsh-resource://file/other/x')
})

test('entering a Session does not reopen what it already holds', () => {
  const desired = [{ kind: 'git-changes', contentId: 'dsh-resource://gitdiff/session/session-a/src/a.rs' }]
  // The Session being entered holds the same tab under its own address.
  const open = [{ kind: 'git-changes', contentId: 'dsh-resource://gitdiff/session/session-b/src/a.rs', tabId: 't1' }]
  assert.deepEqual(missingTabs(desired, open, 'session-b'), [])
})

test('what the set no longer holds is closed on entering', () => {
  const desired = [{ kind: 'git-changes', contentId: 'dsh-resource://gitdiff/session/session-a/src/a.rs' }]
  const open = [
    { kind: 'git-changes', contentId: 'dsh-resource://gitdiff/session/session-b/src/a.rs', tabId: 't1' },
    { kind: 'git-changes', contentId: 'dsh-resource://gitdiff/session/session-b/src/b.rs', tabId: 't2' },
  ]
  // b.rs is not in the set, so it is closed rather than recorded back into it.
  assert.deepEqual(extraTabs(desired, open, 'session-b').map(tab => tab.contentId), [
    'dsh-resource://gitdiff/session/session-b/src/b.rs',
  ])
})
