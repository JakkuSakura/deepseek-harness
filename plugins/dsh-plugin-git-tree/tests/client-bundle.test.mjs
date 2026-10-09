/**
 * Contract tests for the built browser bundle.
 *
 * The bundle is executed exactly the way the Web shell executes it: through
 * `window.__ModuleLoader__.load`, with a `require` that answers module-table
 * entries. That proves the handoff shape, the plugin export, the single
 * registration that puts the panel in the sidebar's Workspaces region, and both
 * of the region's presentations.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gitDiffAddress } from '../lib/testing/client-diff.js'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeRequire = createRequire(import.meta.url)

/** The stub for the one platform module the bundle requires as a value set. */
const primitivesStub = {
  GuideArtworkFiles: () => createElement('span', null, 'git'),
  FileTypeIcon: () => createElement('span', { className: 'stub-file-icon' }),
  IconFolderCloseRegular: () => createElement('span', null, '▸'),
  IconFolderOpenRegular: () => createElement('span', null, '▾'),
  IconRefreshOutlineRegular: () => createElement('span', null, '↻'),
  IconCopyOutlineRegular: () => createElement('span', null, '⧉'),
  IconEditOutlineRegular: () => createElement('span', null, '✎'),
  IconTrashOutlineRegular: () => createElement('span', null, '🗑'),
  IconPlusOutlineRegular: () => createElement('span', null, '＋'),
  IconProjectAddOutlineRegular: () => createElement('span', null, '⊞'),
  PathLabel: ({ path }) => createElement('span', { className: 'stub-path' }, path),
  classifyFileType: () => 'other',
}

/** A `require` that answers only what the shell's module table would. */
function moduleRequire(specifier) {
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  return nodeRequire(specifier)
}

/** Execute the built bundle and return what it registered. */
function loadBundle() {
  const source = readFileSync(resolve(root, 'lib/client.js'), 'utf8')
  let registration
  globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value } } }
  // The bundle is a plain script with no ESM syntax: evaluating it in the global
  // scope runs the loader call exactly once, and re-evaluating it is a fresh
  // execution rather than a cached module.
  // eslint-disable-next-line no-new-func
  new Function(source)()
  assert.ok(registration, 'the bundle never called window.__ModuleLoader__.load')
  return registration
}

/**
 * A client context that records every registration and routes the optional
 * `sidebarRight` injection into a recorded resource opener.
 */
function recordingContext({ withSidebarRight = true, withUiWorkspace = true } = {}) {
  const seen = {
    dictionaries: [], seats: [], effects: [], opened: [], selected: [], started: [],
    archived: [], deletedWorkspaces: [], createdWorkspaces: [], injected: [],
    protocols: [], tabTypes: [], movedWorkspaces: [], movedSessions: [],
  }
  seen.mounted = controllable('session-1')
  seen.openTabs = controllable([])
  seen.workspaceList = controllable({ items: [], archivedSessionIds: [] })
  const ctx = {
    effect(callback, label) { seen.effects.push(label); callback(); return () => {} },
    inject(dependencies, callback) {
      seen.injected.push(dependencies)
      if (dependencies.includes('sidebarRight') && !withSidebarRight) return () => {}
      if (dependencies.includes('uiWorkspace') && !withUiWorkspace) return () => {}
      // The renderer binds the injected members onto the callback's context.
      callback({
        sidebarRight: { openResource: (address) => { seen.opened.push(address) } },
        uiWorkspace: {
          openSession: (sessionId) => { seen.selected.push(String(sessionId)) },
          startSession: (workspaceId) => { seen.started.push(String(workspaceId)) },
          pickDirectory: async () => '/picked/dir',
          archiveSession: async (sessionId) => { seen.archived.push(String(sessionId)) },
        },
        workspaces: {
          delete: async (workspaceId) => { seen.deletedWorkspaces.push(String(workspaceId)) },
          create: async (input) => { seen.createdWorkspaces.push(input.path) },
          insertBefore: async (workspaceId, beforeWorkspaceId) => {
            seen.movedWorkspaces.push([String(workspaceId), beforeWorkspaceId === undefined ? null : String(beforeWorkspaceId)])
          },
          insertSessionBefore: async (workspaceId, sessionId, beforeSessionId) => {
            seen.movedSessions.push([
              String(workspaceId), String(sessionId),
              beforeSessionId === undefined ? null : String(beforeSessionId),
            ])
          },
        },
        sessions: {
          using: async (_target, _options, operation) => operation({
            binding: { session: { rename: async () => ({ ok: true, value: undefined }) } },
          }),
        },
        effect: (effectCallback, label) => { seen.effects.push(label); effectCallback(); return () => {} },
      })
      return () => {}
    },
    locale: {
      bind: () => (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`),
      register: (namespace, dictionaries) => { seen.dictionaries.push({ namespace, dictionaries }); return () => {} },
    },
    slots: {
      inject(name, callback) { callback(); return () => {} },
      register: (options, component) => { seen.seats.push({ options, component }); return () => {} },
    },
    // The two services the Changes tab is built from: the resource protocol it
    // answers on, and the tab type the right Sidebar routes addresses to.
    resources: {
      register: (options) => {
        seen.protocols.push(options)
        // Open the provider so a case can read the frames it yields, then stop it.
        seen.provider = options
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: (definition) => { seen.tabTypes.push(definition); return () => {} },
    },
    // The per-workspace panel memory subscribes to the mounted seat and the
    // Workspace list, and reads the controller's open-tab inventory. All three are
    // controllable, so a case can drive a session switch the way the shell does.
    sidebarRight: {
      mounted: seen.mounted,
      openTabs: seen.openTabs,
      openResource: (address) => { seen.opened.push(address) },
    },
    workspaces: { list: seen.workspaceList },
    remote: {
      workspaceFiles: {
        list: async () => ({ ok: true, value: { path: '', entries: [], truncated: false } }),
      },
    },
  }
  return { ctx, seen }
}

/**
 * One snapshot a case can change and notify, standing in for a store observable.
 * @param initial - the first snapshot.
 * @returns the observable plus a setter that fires every subscriber.
 */
function controllable(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** The Session list snapshot the region folds its outline from. */
const SESSION_LIST = {
  ids: ['session-1'],
  byId: {
    'session-1': {
      id: 'session-1',
      displayTitle: 'Fix the parser',
      cwd: '/tmp/workspace',
      blank: false,
      running: true,
      retainedBy: { mainView: 1 },
    },
  },
}

/** Live status per Session: the row's mark is drawn from this. */
const SESSION_STATUS = new Map([['session-1', { running: true }]])

/** The Workspace snapshot, with one Workspace accounting for that Session. */
const WORKSPACE_LIST = {
  items: [{ workspaceId: 'ws-1', title: 'FerroPhase', path: '/tmp/workspace', sessionIds: ['session-1'] }],
  archivedSessionIds: [],
  pinnedSessionIds: [],
}

/** The composed props a wide sidebars region supplies. */
function regionProps(overrides = {}) {
  return {
    wide: true,
    expandSidebar() {},
    useSessions: selector => selector(SESSION_LIST),
    useWorkspaces: selector => selector(WORKSPACE_LIST),
    useSessionStatus: selector => selector(SESSION_STATUS),
    t: (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`),
    list: async () => ({ ok: true, value: { path: '', entries: [], truncated: false } }),
    stats: async () => ({ status: 'no-repository' }),
    open() {},
    openSession() {},
    newSession() {},
    renameSession: async () => {},
    deleteSession: async () => {},
    deleteWorkspace: async () => {},
    addWorkspace: async () => {},
    ...overrides,
  }
}

test('the bundle registers the package row under its own id', () => {
  const registration = loadBundle()
  assert.equal(registration.id, 'dsh-plugin-git-tree')
  assert.equal(typeof registration.factory, 'function')
  assert.equal(registration.chunk, undefined)
})

test('the factory yields a cordis plugin carrying apply and inject only', () => {
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, [
    'slots', 'sidebarRight', 'locale', 'remote', 'remote.workspaceFiles', 'sessions',
    'resources', 'sidebarRightTabs', 'workspaces',
  ])
})

test('apply shadows the Workspaces region, registers dictionaries, and takes the opener optionally', () => {
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx, seen } = recordingContext()
  plugin.apply(ctx)

  assert.deepEqual(seen.dictionaries.map(entry => entry.namespace), ['gitTree'])
  const [dictionaries] = seen.dictionaries
  assert.deepEqual(Object.keys(dictionaries.dictionaries.zh).sort(), Object.keys(dictionaries.dictionaries.en).sort())

  // Four seats: the region, the Changes tab's body and title, and the entry this
  // bundle adds to every right-Sidebar tab's menu.
  assert.equal(seen.seats.length, 4)
  assert.deepEqual(
    seen.seats.map(seat => seat.options.name).sort(),
    ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'sidebar.right.tab.menu.item', 'sidebar.workspaces'],
  )
  assert.deepEqual(
    { name: panelSeat(seen).options.name, priority: panelSeat(seen).options.priority, locale: panelSeat(seen).options.locale },
    { name: 'sidebar.workspaces', priority: -1, locale: 'gitTree' },
  )
  assert.equal(typeof panelSeat(seen).component, 'function')
  // It declares no children, so it cannot collide with ui-workspace's own.
  assert.equal(panelSeat(seen).options.children, undefined)

  assert.deepEqual(seen.injected, [['sidebarRight'], ['uiWorkspace', 'workspaces']])
  assert.deepEqual(seen.effects, [
    'git-tree: resource opener',
    'git-tree: session operations',
    'git-tree: dictionaries',
    'git-tree: diff resource provider',
    'git-tree: changes tab type',
    'git-tree: changes body',
    // The pill override is installed before the menu entry, so its label sits here.
    'git-tree: token-rate pill override',
      'git-tree: report sessions waiting for input',
    'git-tree: close-all menu entry',
    'git-tree: changes title',
    'git-tree: workspaces region',
  ])
})

test('a composition without the optional services still applies', () => {
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx, seen } = recordingContext({ withSidebarRight: false, withUiWorkspace: false })
  plugin.apply(ctx)
  // The region still registers; the Changes tab's two seats ride along with it.
  assert.ok(panelSeat(seen), 'the region did not register without the optional services')
})

test('the Changes tab type claims this plugin\'s own addresses, and nothing else', () => {
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx, seen } = recordingContext()
  plugin.apply(ctx)

  assert.equal(seen.tabTypes.length, 1)
  const [definition] = seen.tabTypes
  assert.equal(definition.kind, 'git-changes')
  // Only the diff protocol: the file protocol is another type's to claim.
  assert.deepEqual(definition.patterns, ['dsh-resource://gitdiff/**'])
  assert.equal(definition.priority, 'extension')
  assert.equal(definition.title(gitDiffAddress('session-1', 'src/lib/a.ts')), 'a.ts')
})

test('the diff protocol answers a diff address with the route\'s value', async () => {
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx, seen } = recordingContext()
  plugin.apply(ctx)

  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    // A real response, because the reader inspects its status and text before it
    // parses: a route that answers something other than JSON has to be sayable.
    return new Response(JSON.stringify({
      status: 'ok',
      view: { path: 'src/a.ts', diff: '+one\n', truncated: false, untracked: false },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const controller = new AbortController()
    const frames = seen.provider.open(
      gitDiffAddress('session-1', 'src/a.ts'),
      { signal: controller.signal },
    )
    const first = await frames.next()
    controller.abort()
    assert.equal(first.done, false)
    assert.deepEqual(first.value.value, {
      path: 'src/a.ts', diff: '+one\n', truncated: false, untracked: false, failure: null,
    })
    // The Session is the only scope the route trusts, so the path travels beside it.
    assert.match(calls[0], /api\/git-tree\/diff\?sessionId=session-1&path=src%2Fa\.ts/u)
  } finally {
    globalThis.fetch = original
  }
})

test('the Changes body draws the diff it is handed', () => {
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx, seen } = recordingContext()
  plugin.apply(ctx)
  const seat = seen.seats.find(entry => entry.options.name === 'sidebar.right.pane.tab')

  const markup = renderToStaticMarkup(createElement(seat.component, {
    t: (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`),
    useTabInfo: () => ({ tab: { navigation: { address: gitDiffAddress('session-1', 'src/a.ts') } } }),
    useResource: () => ({
      status: 'live',
      value: {
        path: 'src/a.ts',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1,2 @@\n context\n-removed\n+added\n',
        truncated: false,
        untracked: false,
        failure: null,
      },
    }),
  }))
  assert.match(markup, /data-git-diff="tracked"/)
  assert.match(markup, /gt-diff-add[^>]*>\+added/)
  assert.match(markup, /gt-diff-del[^>]*>-removed/)
  assert.match(markup, /gt-diff-hunk/)
})

test('entering a Session leaves the tab layout to DSH', () => {
  // The kit keys a panel layout by Session, so each Session keeps its own tabs without
  // help. An earlier version of this plugin re-opened a Workspace's tabs on entering and
  // closed the ones it no longer held; that override is removed, and this asserts the
  // plugin does not touch tabs at all.
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx } = recordingContext()
  const opened = []
  const closed = []
  ctx.sidebarRight.openResource = (address) => { opened.push(address) }
  ctx.sidebarRight.close = (id) => { closed.push(id) }
  plugin.apply(ctx)
  assert.deepEqual(opened, [], 'the plugin must not open a tab on its own')
  assert.deepEqual(closed, [], 'and must not close one either')
})


test('closing the last tab is remembered, so a collapse does not restore it', () => {
  // Closing the last tab collapses the column, which unmounts the seat. If a
  // missing seat counted as a departure, the next mount would read as an arrival
  // and open the tab the reader had just closed — a loop they cannot break.
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx, seen } = recordingContext()
  plugin.apply(ctx)

  seen.workspaceList.set({ items: [{ workspaceId: 'w1', sessionIds: ['s1'] }], archivedSessionIds: [] })
  seen.mounted.set('s1')
  const address = 'dsh-resource://gitdiff/session/s1/src/a.ts'
  seen.openTabs.set([{ sessionId: 's1', kind: 'git-changes', contentId: address }])

  // The reader closes it: the seat unmounts first, the inventory follows.
  seen.mounted.set(undefined)
  seen.openTabs.set([])
  // Coming back is the same Session, not an arrival.
  seen.mounted.set('s1')

  assert.deepEqual(seen.opened, [])
})

test('a page tab is dropped rather than reopened wrong', () => {
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx, seen } = recordingContext()
  plugin.apply(ctx)

  seen.workspaceList.set({ items: [{ workspaceId: 'w1', sessionIds: ['s1', 's2'] }], archivedSessionIds: [] })
  seen.mounted.set('s1')
  seen.openTabs.set([{ sessionId: 's1', kind: 'guide', contentId: 'guide' }])
  seen.mounted.set('s2')
  assert.deepEqual(seen.opened, [])
})

test('the plugin presses the transcript control when the reader reaches the head', () => {
  const listeners = []
  const original = globalThis.document
  // Enough of a document for the stylesheet tag the plugin injects, the scroll
  // listener it captures, and the transcript mutations it watches.
  const observed = []
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
    body: {},
    addEventListener: (type, listener) => { listeners.push({ type, listener }) },
    removeEventListener: () => {},
  }
  const originalObserver = globalThis.MutationObserver
  globalThis.MutationObserver = class {
    observe(target, options) { observed.push({ target, options }) }
    disconnect() {}
  }
  try {
    const registration = loadBundle()
    const plugin = registration.factory(moduleRequire)
    const { ctx } = recordingContext()
    plugin.apply(ctx)

    // The plugin now captures a click as well, to tell the reader's collapse from its
    // own auto-open, so the assertion asks for the scroll listener rather than for it
    // being the only one.
    const scroll = listeners.find(listener => listener.type === 'scroll')
    assert.ok(scroll, 'the transcript control no longer watches for scrolling')
    let presses = 0
    const button = { disabled: false, click: () => { presses += 1 } }
    const wrapper = { querySelector: () => button }
    scroll.listener({ target: { scrollTop: 4, querySelector: () => wrapper } })
    assert.equal(presses, 1)

    // And the transcript is watched for process rows to open. More than one
    // observer is installed now — the token-rate pill override watches too — so this
    // asks that the transcript is watched, not that it is the only thing watched.
    assert.ok(observed.length >= 1, 'nothing watched the transcript')
    assert.ok(observed.some(observer => observer.options.subtree === true), 'no observer watched a subtree')
  } finally {
    if (original === undefined) delete globalThis.document
    else globalThis.document = original
    if (originalObserver === undefined) delete globalThis.MutationObserver
    else globalThis.MutationObserver = originalObserver
  }
})

test('a wide region leads with the Sessions tab and keeps the other two beside it', () => {
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx, seen } = recordingContext()
  plugin.apply(ctx)
  const Panel = panelSeat(seen).component

  const markup = renderToStaticMarkup(createElement(Panel, regionProps()))
  assert.match(markup, /data-git-panel="wide"/)
  assert.match(markup, /role="tablist"/)
  // Strip order is Sessions, Worktree, Files.
  const labels = [...markup.matchAll(/class="gt-tab"[^>]*>([^<]+)</gu)].map(match => match[1])
  assert.deepEqual(labels, ['tab.sessions', 'tab.worktree', 'tab.files'])
  // Sessions is the selected tab and the one that renders first.
  assert.match(markup, /data-git-view="sessions"/)
  assert.match(markup, /aria-selected="true" data-active="true">tab\.sessions/)
  assert.doesNotMatch(markup, /data-git-view="worktree"/)
  assert.doesNotMatch(markup, /data-git-view="files"/)
})

/** The panel component from a fresh recording context. */
/**
 * The seat the panel itself registers.
 *
 * The plugin now contributes three seats — this region, and the Changes tab's
 * body and title in the right Sidebar — so a case selects by name rather than by
 * position in the list.
 * @param seen - the recording context's captures.
 * @returns the seat registered for the sidebar's Workspaces region.
 */
function panelSeat(seen) {
  return seen.seats.find(seat => seat.options.name === 'sidebar.workspaces')
}

function sessionPanelComponent() {
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx, seen } = recordingContext()
  plugin.apply(ctx)
  return panelSeat(seen).component
}

test('a Session row is marked by its live status', () => {
  const markup = renderToStaticMarkup(createElement(sessionPanelComponent(), regionProps()))
  // The running Session in the fixture is marked, and the state is said as well as
  // drawn — a colour and a spin carry nothing to a reader who cannot see them.
  assert.match(markup, /gt-session-mark" data-status="running"/)
  assert.match(markup, />session\.status\.running</)
})

test('the Sessions tab draws the folded outline with the active row marked', () => {
  const Panel = sessionPanelComponent()

  const markup = renderToStaticMarkup(createElement(Panel, regionProps()))
  assert.match(markup, /FerroPhase/)
  assert.match(markup, /Fix the parser/)
  assert.match(markup, /data-active="true"/)
  // The running Session carries the mark its live status gives it.
  assert.match(markup, /gt-session-mark" data-status="running"/)
})

/** The panel component, with a Workspace that accounts for no Sessions at all. */
function emptyWorkspacePanel() {
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx, seen } = recordingContext()
  plugin.apply(ctx)
  return {
    Panel: panelSeat(seen).component,
    props: regionProps({
      useSessions: selector => selector({ ids: [], byId: {}, projectionsBySession: {}, phase: 'ready' }),
      useWorkspaces: selector => selector({
        items: [{ workspaceId: 'ws-empty', title: 'Empty', path: '/tmp/empty', sessionIds: [] }],
        archivedSessionIds: [],
        pinnedSessionIds: [],
        state: 'idle',
        phase: 'ready',
        error: null,
      }),
    }),
  }
}

test('an empty Workspace is drawn with a delete action, and a populated one is not', () => {
  const { Panel, props } = emptyWorkspacePanel()
  const markup = renderToStaticMarkup(createElement(Panel, props))
  assert.match(markup, /Empty/)
  assert.match(markup, /data-empty="true"/)
  assert.match(markup, /aria-label="workspace\.delete[^"]*Empty/)
  // The tab-level action row is present.
  assert.match(markup, /gt-actions/)

  // A Workspace that still holds a Session offers no delete.
  const populated = renderToStaticMarkup(createElement(sessionPanelComponent(), regionProps()))
  assert.match(populated, /data-empty="false"/)
  assert.doesNotMatch(populated, /aria-label="workspace\.delete/)
})

test('the injected face arranges Workspaces and their Sessions through the registry', async () => {
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx, seen } = recordingContext()
  plugin.apply(ctx)

  const face = panelSeat(seen).options.inject()
  await face.moveWorkspace('ws-2', 'ws-1')
  await face.moveSession('ws-1', 'session-2', 'session-1')
  // An anchor is optional: without one the registry appends.
  await face.moveWorkspace('ws-3')
  await face.moveSession('ws-1', 'session-3')

  assert.deepEqual(seen.movedWorkspaces, [['ws-2', 'ws-1'], ['ws-3', null]])
  assert.deepEqual(seen.movedSessions, [
    ['ws-1', 'session-2', 'session-1'],
    ['ws-1', 'session-3', null],
  ])
})

test('the injected face removes a Workspace through the registry command', async () => {
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx, seen } = recordingContext()
  plugin.apply(ctx)

  const face = panelSeat(seen).options.inject()
  await face.deleteWorkspace('ws-empty')
  assert.deepEqual(seen.deletedWorkspaces, ['ws-empty'])
})

test('the tab action row offers only Add workspace; Sessions start from a Workspace +', () => {
  const markup = renderToStaticMarkup(createElement(sessionPanelComponent(), regionProps()))
  // Asserted on the buttons themselves: these tests make `t` return the key, so a
  // copy-based assertion would also match the header's aria-label.
  const actions = [...markup.matchAll(/data-git-action="([a-z-]+)"/gu)].map(match => match[1])
  assert.deepEqual(actions, ['add-workspace'])
  // The per-Workspace header still owns the small New Session button.
  assert.match(markup, /aria-label="session\.new — FerroPhase"/)
})

test('the shell New Session button is hidden, and the rail keeps one of its own', () => {
  const Panel = sessionPanelComponent()
  // The rule ships with the panel's stylesheet, scoped to the layout's sidebar seat.
  assert.match(readFileSync(resolve(root, 'lib/client.js'), 'utf8'), /data-slot='sidebar'\] \[class\*='_newSession'\]/)

  const rail = renderToStaticMarkup(createElement(Panel, regionProps({ wide: false })))
  assert.match(rail, /data-git-panel="rail"/)
  assert.match(rail, /aria-label="session\.new"/)
})

test('adding a Workspace picks a directory, then registers it', async () => {
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx, seen } = recordingContext()
  plugin.apply(ctx)

  await panelSeat(seen).options.inject().addWorkspace()
  assert.deepEqual(seen.createdWorkspaces, ['/picked/dir'])
})

test('a renamed blank Session shows its own title rather than the New Session label', () => {
  const { Panel } = emptyWorkspacePanel()
  const markup = renderToStaticMarkup(createElement(Panel, regionProps({
    useSessions: selector => selector({
      ids: ['session-7'],
      byId: {
        'session-7': {
          id: 'session-7',
          title: 'Parser spike',
          displayTitle: 'Parser spike',
          blank: true,
          running: false,
          cwd: '/tmp/workspace',
          retainedBy: { mainView: 1 },
        },
      },
      projectionsBySession: {},
      phase: 'ready',
    }),
    useWorkspaces: selector => selector({
      items: [{ workspaceId: 'ws-1', title: 'FerroPhase', path: '/tmp/workspace', sessionIds: ['session-7'] }],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      state: 'idle',
      phase: 'ready',
      error: null,
    }),
  })))
  assert.match(markup, /Parser spike/)
  assert.doesNotMatch(markup, />New Session</)
})

test('the tab strip offers no reload control, because the git tabs poll', () => {
  const markup = renderToStaticMarkup(createElement(sessionPanelComponent(), regionProps()))
  assert.doesNotMatch(markup, /aria-label="reload"/)
  assert.doesNotMatch(markup, /Reload/)

  // The poll ships with the panel: a one-second interval, guarded so a tick cannot
  // stack a second read behind one that is still out.
  const source = readFileSync(resolve(root, 'lib/client.js'), 'utf8')
  assert.match(source, /setInterval\(/)
  assert.match(source, /1e3|1000/)
  assert.match(source, /clearInterval\(/)
})

test('a Session row offers clone, rename and delete, and doubles as the rename gesture', () => {
  const markup = renderToStaticMarkup(createElement(sessionPanelComponent(), regionProps()))
  assert.match(markup, /aria-label="session\.rename"/)
  assert.match(markup, /aria-label="session\.delete"/)
  // Clone is asserted for a reason: the first version of the button rendered an icon the
  // test stub did not have, so React threw on an undefined element type and every render
  // test failed. The assertion is what makes that a test failure rather than a surprise.
  assert.match(markup, /aria-label="session\.clone"/)
  assert.match(markup, /gt-session-open/)
})

test('the injected face carries the Session operations to the Workspace services', async () => {
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx, seen } = recordingContext()
  plugin.apply(ctx)
  const face = panelSeat(seen).options.inject()

  face.newSession('ws-9')
  await face.deleteSession('session-9')
  assert.deepEqual(seen.started, ['ws-9'])
  assert.deepEqual(seen.archived, ['session-9'])
})

test('selecting a Session row drives the Workspace browser navigation service', () => {
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx, seen } = recordingContext()
  plugin.apply(ctx)

  const face = panelSeat(seen).options.inject()
  face.openSession('session-9')
  assert.deepEqual(seen.selected, ['session-9'])
})

test('the rail renders when the column is collapsed', () => {
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx, seen } = recordingContext()
  plugin.apply(ctx)
  const Panel = panelSeat(seen).component

  const markup = renderToStaticMarkup(createElement(Panel, regionProps({ wide: false })))
  assert.match(markup, /data-git-panel="rail"/)
  assert.doesNotMatch(markup, /role="tablist"/)
})

test('the injected face builds a session file address for a relative path', () => {
  const registration = loadBundle()
  const plugin = registration.factory(moduleRequire)
  const { ctx, seen } = recordingContext()
  plugin.apply(ctx)

  // Reach the face through the registration's inject factory.
  const face = panelSeat(seen).options.inject()
  face.open('session-1', 'crates/parser/src/lib.rs')
  assert.deepEqual(seen.opened, [
    'dsh-resource://file/session/session-1/crates/parser/src/lib.rs',
  ])

  face.open('session-1', 'a b/c#d.txt')
  assert.deepEqual(seen.opened[1], 'dsh-resource://file/session/session-1/a%20b/c%23d.txt')
})
