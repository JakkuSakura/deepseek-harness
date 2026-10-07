/**
 * Tests for the Sessions tab's pure fold: the Workspace → Session outline the
 * panel draws after shadowing the shell's own browser.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dropSide, groupSessions, resolveDrop, sessionMarkOf } from '../lib/testing/client-sessions.js'

const session = (id, overrides = {}) => ({
  id,
  displayTitle: `title ${id}`,
  blank: false,
  running: false,
  retainedBy: { mainView: 0 },
  ...overrides,
})

const workspace = (workspaceId, sessionIds, overrides = {}) => ({
  workspaceId,
  path: `/ws/${workspaceId}`,
  title: `ws ${workspaceId}`,
  sessionIds,
  ...overrides,
})

test('groups sessions under their Workspace in manual order', () => {
  const groups = groupSessions({
    workspaces: [workspace('a', ['s2', 's1']), workspace('b', ['s3'])],
    sessions: {
      s1: session('s1', { displayTitle: 'one' }),
      s2: session('s2', { displayTitle: 'two' }),
      s3: session('s3', { displayTitle: 'three' }),
    },
    archived: [],
    activeId: 's2',
  })
  assert.deepEqual(groups.map(group => group.workspaceId), ['a', 'b'])
  assert.deepEqual(groups[0].sessions.map(row => row.title), ['two', 'one'])
  assert.deepEqual(groups[0].sessions.map(row => row.active), [true, false])
  assert.equal(groups[0].title, 'ws a')
  assert.equal(groups[0].path, '/ws/a')
  assert.deepEqual(groups[1].sessions.map(row => row.title), ['three'])
})

test('drops archived Sessions, subagent Sessions, and rows with no Session yet', () => {
  const groups = groupSessions({
    workspaces: [workspace('a', ['keep', 'archived', 'subagent', 'unknown'])],
    sessions: {
      keep: session('keep'),
      archived: session('archived'),
      subagent: session('subagent', { origin: 'subagent' }),
    },
    archived: ['archived'],
    activeId: undefined,
  })
  assert.deepEqual(groups[0].sessions.map(row => String(row.id)), ['keep'])
})

test('keeps a Workspace with nothing left in it, so it can be deleted from here', () => {
  const groups = groupSessions({
    workspaces: [workspace('a', ['gone'])],
    sessions: {},
    archived: [],
    activeId: undefined,
  })
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].sessions, [])
  assert.equal(groups[0].title, 'ws a')
  assert.equal(groups[0].path, '/ws/a')
})

test('carries the blank and running flags the rows render from', () => {
  const groups = groupSessions({
    workspaces: [workspace('a', ['blank', 'busy'])],
    sessions: {
      blank: session('blank', { blank: true }),
      busy: session('busy', { running: true }),
    },
    archived: [],
    activeId: 'blank',
  })
  assert.deepEqual(groups[0].sessions.map(row => [row.blank, row.running, row.active]), [
    [true, false, true],
    [false, true, false],
  ])
})

test('reports whether a Session has a durable title of its own', () => {
  const groups = groupSessions({
    workspaces: [workspace('a', ['untitled', 'renamed'])],
    sessions: {
      untitled: session('untitled', { blank: true, displayTitle: 'ws a' }),
      renamed: session('renamed', { blank: true, title: 'Parser spike', displayTitle: 'Parser spike' }),
    },
    archived: [],
    activeId: undefined,
  })
  const rows = new Map(groups[0].sessions.map(row => [String(row.id), row]))
  assert.equal(rows.get('untitled').named, false)
  assert.equal(rows.get('renamed').named, true)
  assert.equal(rows.get('renamed').title, 'Parser spike')
})

test('dragging a Workspace onto another moves it before that one', () => {
  const dragged = { kind: 'workspace', workspaceId: 'w2' }
  assert.deepEqual(resolveDrop(dragged, { kind: 'workspace', workspaceId: 'w1' }), {
    kind: 'move-workspace', workspaceId: 'w2', beforeWorkspaceId: 'w1',
  })
})

test('dropping a Workspace on the outline appends it', () => {
  assert.deepEqual(resolveDrop({ kind: 'workspace', workspaceId: 'w1' }, { kind: 'workspace-list' }), {
    kind: 'move-workspace', workspaceId: 'w1',
  })
})

test('a Workspace dropped on itself, on a Session, or on its own list does nothing', () => {
  const dragged = { kind: 'workspace', workspaceId: 'w1' }
  assert.equal(resolveDrop(dragged, { kind: 'workspace', workspaceId: 'w1' }), null)
  assert.equal(resolveDrop(dragged, { kind: 'session', workspaceId: 'w1', sessionId: 's1' }), null)
  assert.equal(resolveDrop(dragged, { kind: 'session-list', workspaceId: 'w1' }), null)
})

test('a Session moves before the row it is dropped on, within its Workspace', () => {
  const dragged = { kind: 'session', workspaceId: 'w1', sessionId: 's3' }
  assert.deepEqual(resolveDrop(dragged, { kind: 'session', workspaceId: 'w1', sessionId: 's1' }), {
    kind: 'move-session', workspaceId: 'w1', sessionId: 's3', beforeSessionId: 's1',
  })
})

test('a Session dropped in its Workspace’s row space appends', () => {
  assert.deepEqual(
    resolveDrop({ kind: 'session', workspaceId: 'w1', sessionId: 's3' }, { kind: 'session-list', workspaceId: 'w1' }),
    { kind: 'move-session', workspaceId: 'w1', sessionId: 's3' },
  )
})

test('a Session is never moved out of its Workspace', () => {
  // A Session's workspace resolves its working directory, so carrying one across is
  // a different act than arranging — and this panel only arranges.
  const dragged = { kind: 'session', workspaceId: 'w1', sessionId: 's1' }
  assert.equal(resolveDrop(dragged, { kind: 'session', workspaceId: 'w2', sessionId: 's9' }), null)
  assert.equal(resolveDrop(dragged, { kind: 'session-list', workspaceId: 'w2' }), null)
  assert.equal(resolveDrop(dragged, { kind: 'workspace', workspaceId: 'w2' }), null)
  assert.equal(resolveDrop(dragged, { kind: 'workspace-list' }), null)
})

test('a Session dropped on itself does nothing, and nothing dragged means nothing', () => {
  const dragged = { kind: 'session', workspaceId: 'w1', sessionId: 's1' }
  assert.equal(resolveDrop(dragged, { kind: 'session', workspaceId: 'w1', sessionId: 's1' }), null)
  assert.equal(resolveDrop(null, { kind: 'workspace-list' }), null)
})

test('dragging a Session down lands it in the target\'s place, not above it', () => {
  // The bug this exists for: "before the row below" is where the item already is,
  // so a downward drag looked like it did nothing at all.
  const order = ['s1', 's2', 's3']
  const dragged = { kind: 'session', workspaceId: 'w1', sessionId: 's1' }
  assert.deepEqual(resolveDrop(dragged, { kind: 'session', workspaceId: 'w1', sessionId: 's2' }, order), {
    kind: 'move-session', workspaceId: 'w1', sessionId: 's1', beforeSessionId: 's3',
  })
})

test('dragging a Session down past the last row appends it', () => {
  const order = ['s1', 's2']
  const dragged = { kind: 'session', workspaceId: 'w1', sessionId: 's1' }
  const action = resolveDrop(dragged, { kind: 'session', workspaceId: 'w1', sessionId: 's2' }, order)
  assert.equal(action.kind, 'move-session')
  assert.equal(action.sessionId, 's1')
  // No anchor is the registry's append, whether the key is absent or undefined.
  assert.equal(action.beforeSessionId, undefined)
})

test('dragging a Session up still lands before the target', () => {
  const order = ['s1', 's2', 's3']
  const dragged = { kind: 'session', workspaceId: 'w1', sessionId: 's3' }
  assert.deepEqual(resolveDrop(dragged, { kind: 'session', workspaceId: 'w1', sessionId: 's1' }, order), {
    kind: 'move-session', workspaceId: 'w1', sessionId: 's3', beforeSessionId: 's1',
  })
})

test('dragging a Workspace down lands it in the target\'s place too', () => {
  const order = ['w1', 'w2', 'w3']
  const dragged = { kind: 'workspace', workspaceId: 'w1' }
  assert.deepEqual(resolveDrop(dragged, { kind: 'workspace', workspaceId: 'w2' }, order), {
    kind: 'move-workspace', workspaceId: 'w1', beforeWorkspaceId: 'w3',
  })
  const append = resolveDrop(dragged, { kind: 'workspace', workspaceId: 'w3' }, order)
  assert.equal(append.kind, 'move-workspace')
  assert.equal(append.beforeWorkspaceId, undefined)
})

test('the mark says which edge of the target the drop lands on', () => {
  const order = ['s1', 's2', 's3']
  const dragged = { kind: 'session', workspaceId: 'w1', sessionId: 's1' }
  assert.equal(dropSide(dragged, { kind: 'session', workspaceId: 'w1', sessionId: 's2' }, order), 'after')
  const upwards = { kind: 'session', workspaceId: 'w1', sessionId: 's3' }
  assert.equal(dropSide(upwards, { kind: 'session', workspaceId: 'w1', sessionId: 's2' }, order), 'before')
  assert.equal(dropSide(dragged, { kind: 'session-list', workspaceId: 'w1' }, order), 'after')
  assert.equal(dropSide(dragged, { kind: 'session', workspaceId: 'w1', sessionId: 's1' }, order), undefined)
  assert.equal(dropSide(null, { kind: 'session', workspaceId: 'w1', sessionId: 's2' }, order), undefined)
})

test('a Session carries no mark until there is something to say', () => {
  assert.equal(sessionMarkOf(false, undefined), 'none')
  assert.equal(sessionMarkOf(false, {}), 'none')
  assert.equal(sessionMarkOf(false, { completionUnread: false }), 'none')
  // The summary leads on running, and the status store can also say so.
  assert.equal(sessionMarkOf(true, undefined), 'running')
  assert.equal(sessionMarkOf(true, {}), 'running')
  assert.equal(sessionMarkOf(false, { running: true }), 'running')
})

test('a finished Session is marked only while its result is unread', () => {
  // Reading clears it: a mark that stays lit for work already looked at stops
  // meaning anything.
  assert.equal(sessionMarkOf(false, { completionUnread: true }), 'unread')
  assert.equal(sessionMarkOf(false, { completionUnread: false }), 'none')
  // Running wins over unread: work in flight is not a result to read.
  assert.equal(sessionMarkOf(true, { completionUnread: true }), 'running')
})

test('a Session waiting on the reader outranks one that is running', () => {
  // A Session that asked a question is stopped until it is answered, so the thing
  // worth saying is that it is waiting — not that work is in flight.
  assert.equal(sessionMarkOf(true, { pendingInteraction: { kind: 'approval' } }), 'input')
  assert.equal(sessionMarkOf(false, { pendingInteraction: { kind: 'question' } }), 'input')
  // And it outranks an unread result, which is the least urgent of the three.
  assert.equal(sessionMarkOf(false, { completionUnread: true, pendingInteraction: { kind: 'question' } }), 'input')
})

test('the outline carries each row\'s mark', () => {
  const groups = groupSessions({
    workspaces: [workspace('a', ['busy', 'asking', 'done'])],
    sessions: {
      busy: session('busy'),
      asking: session('asking'),
      done: session('done'),
    },
    archived: [],
    activeId: undefined,
    statuses: new Map([
      ['busy', { running: true }],
      ['asking', { pendingInteraction: { kind: 'question' } }],
    ]),
  })
  assert.deepEqual(groups[0].sessions.map(row => [String(row.id), row.status]), [
    ['busy', 'running'],
    ['asking', 'input'],
    ['done', 'none'],
  ])
})
