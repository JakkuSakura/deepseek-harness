/**
 * Browser half: put a tabbed git panel where the sidebar's Workspaces browser
 * renders.
 *
 * The shell declares `sidebar.workspaces`; `ui-workspace` fills it at the default
 * priority. This registration sits at `priority: -1` — a `single` slot renders
 * its **lowest** live priority — so the workspace browser is shadowed rather than
 * unregistered: its child slots stay declared for the plugins that contribute to
 * them, and it resumes untouched when this plugin unloads or is disabled.
 *
 * `dsh.client.external` is empty because nothing beyond the shell's module-table
 * baseline is requested: the Session list, the Workspace browser's navigation
 * service, the sidebar service, and the resource controller are all reached
 * through Cordis services, and `dsh-util-workspace-path` is a pure fold the
 * bundle inlines.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ChangesTitle, ChangesView } from './ChangesView.tsx'
import { CloseAllMenuItem } from './CloseAllMenuItem.tsx'
import {
  GIT_DIFF_PROTOCOL, parseGitDiffAddress, readGitDiff, titleOfDiffAddress, unreadableDiff,
} from './diff.ts'
import { installAutoHistory } from './autohistory.ts'
import { installExpandProcessRows, opensProcessRows } from './expandall.ts'
import { closeEveryTab } from './closeall.ts'
import { createGitSidebarFace } from './face.ts'
import { installWaitingReporter } from './notify.ts'
import { installRateOverride } from './pillrate.ts'
import { en, zh } from './locales.ts'
import { GitSidebar } from './SidebarPanel.tsx'
import { injectGitTreeStyles } from './styles.ts'

export type { GitSidebarProps } from './SidebarPanel.tsx'
export type { GitSidebarFace } from './face.ts'
export type { GitTreeKey } from './locales.ts'
export type { LevelState } from './levels.ts'


/**
 * Wait one poll interval, or return as soon as the holder goes away.
 * @param signal - the resource holder's lifetime.
 * @returns a promise settled by the timer or by abort.
 */
function settlePoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, DIFF_POLL_MS)
    signal.addEventListener('abort', done, { once: true })
  })
}

/** This package's copy namespace. */
const NS = 'gitTree'

/**
 * The slice of the Client Session object layer this plugin calls.
 *
 * `Context.sessions` is declared by both halves of a DSH installation — by
 * `@deepseek-ai/dsh-session` for the Host and by
 * `@deepseek-ai/dsh-api-session-controller/client` for the browser — and a
 * single-program checkout resolves the Host one. Narrowing the view here keeps the
 * rename call typed and states the collision instead of hiding it; splitting the
 * Host and Client compiler programs, the way the DSH repository does, is the fix
 * that removes the need for it.
 */
interface ClientSessionRenamer {
  using<Selected>(
    target: SessionId,
    options: { readonly source: 'gitTreePanelOperation' },
    operation: (reference: ClientSessionReference) => Selected,
  ): Promise<RemoteResult<Selected>>
}

/** One retained Client Session, only as far as a retitle needs it. */
interface ClientSessionReference {
  readonly binding: {
    readonly session: {
      rename(title: string): Promise<RemoteResult<unknown>>
    }
  }
}

/**
 * Required browser services: the keyed seats, the Remote carrier with its
 * namespace, and copy. The resource controller is injected optionally so a
 * composition without a right Sidebar still renders the region.
 */
export const inject = [
  'slots',
  'sidebarRight',
  'locale',
  'remote',
  'remote.workspaceFiles',
  'sessions',
  'resources',
  'sidebarRightTabs',
  'workspaces',
]

/** The tab type's implementation identity; its body and title register under it. */
const CHANGES_ID = 'dsh-plugin-git-tree/changes'
/** The page kind this tab type is. */
const CHANGES_KIND = 'git-changes'
/** How often an open diff re-reads the path it names. */
const DIFF_POLL_MS = 1000

/**
 * Client plugin body: register the dictionaries and the Workspaces region.
 * @param ctx - client root context carrying the slots, the Remote face, and copy.
 */
export function apply(ctx: ClientContext): void {
  injectGitTreeStyles()

  // Opening a file is the right Sidebar's job and selecting a Session is the
  // Workspace browser's. Both are taken optionally: shadowing the region must not
  // depend on the plugins that provide those actions, and without them the
  // affected rows simply do nothing.
  let openAddress: (address: string) => void = () => {}
  ctx.inject(['sidebarRight'], (scoped) => {
    openAddress = (address: string): void => { scoped.sidebarRight.openResource(address) }
    scoped.effect(() => () => { openAddress = (): void => {} }, 'git-tree: resource opener')
  })

  // Session operations are the Workspace browser's; each degrades to a no-op
  // without it. A rename is the one operation that needs no navigation service:
  // it is written into the Session's own log through the Session object layer.
  const noop = (): void => {}
  let openSession: (sessionId: SessionId) => void = noop
  let newSession: (workspaceId?: string) => void = noop
  let deleteSession: (sessionId: SessionId) => Promise<void> = async () => {}
  let deleteWorkspace: (workspaceId: string) => Promise<void> = async () => {}
  let addWorkspace: () => Promise<void> = async () => {}
  let moveWorkspace: (workspaceId: string, beforeWorkspaceId?: string) => Promise<void> = async () => {}
  let moveSession: (
    workspaceId: string,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ) => Promise<void> = async () => {}
  ctx.inject(['uiWorkspace', 'workspaces'], (scoped) => {
    openSession = (sessionId: SessionId): void => { scoped.uiWorkspace.openSession(sessionId) }
    newSession = (workspaceId?: string): void => {
      scoped.uiWorkspace.startSession(workspaceId as Parameters<typeof scoped.uiWorkspace.startSession>[0])
    }
    deleteSession = (sessionId: SessionId): Promise<void> => scoped.uiWorkspace.archiveSession(sessionId)
    // The registry command behind the shell's own Workspace delete.
    deleteWorkspace = (workspaceId: string): Promise<void> => scoped.workspaces.delete(
      workspaceId as Parameters<typeof scoped.workspaces.delete>[0],
    )
    // The registry owns both orders, and both of its moves mean "place this
    // before that, or at the end when there is no anchor".
    moveWorkspace = async (workspaceId: string, beforeWorkspaceId?: string): Promise<void> => {
      await scoped.workspaces.insertBefore(
        workspaceId as Parameters<typeof scoped.workspaces.insertBefore>[0],
        beforeWorkspaceId as Parameters<typeof scoped.workspaces.insertBefore>[1],
      )
    }
    moveSession = async (
      workspaceId: string,
      sessionId: SessionId,
      beforeSessionId?: SessionId,
    ): Promise<void> => {
      await scoped.workspaces.insertSessionBefore(
        workspaceId as Parameters<typeof scoped.workspaces.insertSessionBefore>[0],
        sessionId as Parameters<typeof scoped.workspaces.insertSessionBefore>[1],
        beforeSessionId as Parameters<typeof scoped.workspaces.insertSessionBefore>[2],
      )
    }
    // The Host derives the title from the path, so `create` takes only `path`.
    addWorkspace = async (): Promise<void> => {
      const path = await scoped.uiWorkspace.pickDirectory()
      if (path === null) return
      await scoped.workspaces.create({ path })
    }
    scoped.effect(() => () => {
      openSession = noop
      newSession = noop
      deleteSession = async () => {}
      deleteWorkspace = async () => {}
      addWorkspace = async () => {}
      moveWorkspace = async () => {}
      moveSession = async () => {}
    }, 'git-tree: session operations')
  })

  const renameSession = async (sessionId: SessionId, title: string): Promise<void> => {
    const renamer = ctx.sessions as unknown as ClientSessionRenamer
    const result = await renamer.using(
      sessionId,
      { source: 'gitTreePanelOperation' },
      reference => reference.binding.session.rename(title),
    )
    if (!result.ok) throw new Error(result.error.message)
  }

  /**
   * Branch a Session, and go to the branch.
   *
   * The Host owns the fork: it copies the transcript up to the latest completed turn
   * and records this Session as the child's parent. Opening the child is part of the
   * action rather than left to the reader — pressing clone and staying put would look
   * like nothing had happened.
   * @param sessionId - the Session to copy.
   */
  const cloneSession = async (sessionId: SessionId): Promise<void> => {
    const forker = ctx.sessions as unknown as {
      fork?: (options: { sessionId: SessionId }) => Promise<SessionId | undefined>
    }
    if (forker.fork === undefined) throw new Error('this build cannot fork a session')
    const childId = await forker.fork({ sessionId })
    if (childId === undefined) throw new Error('the clone returned no session')
    openSession(childId)
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'git-tree: dictionaries')

  // The protocol behind a diff address. A holder subscribes and the provider
  // re-reads on a timer, so a tab follows the working tree the way the panel
  // does; a read that says what the last one said publishes no frame, because a
  // frame is a change notice and re-publishing an unchanged diff would re-render
  // the body once a second for nothing.
  ctx.effect(() => ctx.resources.register<'gitdiff'>({
    protocol: GIT_DIFF_PROTOCOL,
    async *open(address, { signal }) {
      const target = parseGitDiffAddress(address)
      if (target === null) {
        yield { ok: true, value: unreadableDiff(address, 'bad-address', `not a diff address: ${address}`) }
        return
      }
      let published = ''
      let first = true
      while (!signal.aborted) {
        const value = await readGitDiff(target.sessionId, target.path, signal)
        if (signal.aborted) return
        // A frame is a change notice: re-publishing a value the holder already
        // has would re-render the body once a second for nothing.
        const key = `${value.path}\u0000${String(value.truncated)}\u0000${value.diff}\u0000${value.failure?.code ?? ''}\u0000${value.failure?.message ?? ''}`
        if (first || key !== published) {
          first = false
          published = key
          yield { ok: true, value }
        }
        await settlePoll(signal)
      }
    },
  }), 'git-tree: diff resource provider')

  // A tab type whose rows the Worktree list opens. It is registered in the
  // `extension` band — a type from outside the product, which is what this is —
  // and claims only its own protocol's addresses.
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: CHANGES_ID,
    kind: CHANGES_KIND,
    patterns: [`dsh-resource://${GIT_DIFF_PROTOCOL}/**`],
    priority: 'extension',
    title: address => titleOfDiffAddress(address),
  }), 'git-tree: changes tab type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: CHANGES_ID,
    locale: NS,
    // A picture needs bytes, and a diff address names both the Session and the
    // path they belong to — so the body asks for one side and gets a URL back,
    // without holding either transport.
    inject: () => ({
      readImage: async (address: string, side: 'before' | 'after', signal: AbortSignal) => {
        const parsed = parseGitDiffAddress(address)
        if (parsed === null) return { failure: 'this address names no file' }
        if (side === 'before') {
          return face().previousImage(parsed.sessionId, parsed.path, signal)
        }
        const read = await ctx.remote.workspaceFiles.readBytes(parsed.sessionId, parsed.path, {}, signal)
        if (!read.ok) return { failure: read.error.message }
        const url = URL.createObjectURL(new Blob([read.value.data]))
        const revoke = (): void => { URL.revokeObjectURL(url) }
        return { url, revoke }
      },
    }),
  }, ChangesView)), 'git-tree: changes body')

  // The pill's own component cannot be reached — see the module for why — so its
  // figure is overwritten in the DOM and kept overwritten.
  ctx.effect(() => installRateOverride(), 'git-tree: token-rate pill override')

  // The Host's fold cannot see this one: "waiting for input" is an approval or a
  // question raised by a client flow, never written to the Session log. The panel
  // draws it, so the panel reports it — only on the transition, so a reader who
  // steps away is told once rather than repeatedly.
  ctx.effect(() => installWaitingReporter(), 'git-tree: report sessions waiting for input')

  // Every tab's menu gets one extra entry. The `label` is thunked so the kit's
  // own projections follow a language change without a re-registration.
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.menu.item', () => ctx.slots.register({
    name: 'sidebar.right.tab.menu.item',
    id: CHANGES_ID,
    order: 100,
    label: () => ctx.locale.bind(NS)('tabs.closeAll'),
    locale: NS,
    inject: () => ({ closeAllTabs }),
  }, CloseAllMenuItem)), 'git-tree: close-all menu entry')

  // The chip follows navigation: one tab serves every path, so a title captured
  // at open time would keep naming the first file opened in it.
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: CHANGES_ID,
  }, ChangesTitle)), 'git-tree: changes title')

  // Older history pages from a control in the transcript and from nothing else, so
  // this presses it when the reader reaches the head. It is a chat concern rather
  // than a git one; it lives here because this bundle is what this profile ships.
  if (typeof document !== 'undefined') {
    ctx.effect(() => installAutoHistory(document), 'git-tree: auto earlier history')
    ctx.effect(() => {
      // Read through the settings service rather than assuming a mode: a composition
      // without it leaves the transcript exactly as DSH rendered it.
      // Read opportunistically: requiring this service would hold the whole client half
      // un-activated if it is ever absent, and losing the plugin costs far more than
      // losing the mode gate — the pill's live rate is published from it.
      const forms = (ctx as unknown as {
        get?(name: string): unknown
      }).get?.('configForms') as { get(namespace: string): {
        getSnapshot(): { value?: { transcriptView?: string } }
        subscribe(listener: () => void): () => void
      } | undefined } | undefined
      const settings = forms?.get('ui-chat')
      const opens = (): boolean => opensProcessRows(settings?.getSnapshot()?.value?.transcriptView)
      const dispose = installExpandProcessRows(document, undefined, opens)
      const unsubscribe = settings?.subscribe(() => {})
      return () => { dispose(); unsubscribe?.() }
    }, 'git-tree: open process rows')
  }

  // ── panels follow their Session ──────────────────────────────────────────────
  // DSH's kit already keys a right-panel layout by Session, which is what this panel
  // wants: every Session keeps its own tabs, and moving between them shelves and restores
  // nothing. An earlier version overrode that to shelve tabs per Workspace, and is gone —
  // so nothing here opens or closes a tab on the reader's behalf.

  // The controller is a service, not an optional one: the sidebar is mounted
  // whenever this region is, so the walk reads it directly.
  const closeAllTabs = async (): Promise<void> => {
    await closeEveryTab(ctx.sidebarRight)
  }

  const face = createGitSidebarFace(
    ctx.remote,
    (address: string) => { openAddress(address) },
    closeAllTabs,
    {
      openSession: (sessionId: SessionId) => { openSession(sessionId) },
      newSession: (workspaceId?: string) => { newSession(workspaceId) },
      renameSession,
      cloneSession,
      deleteSession: (sessionId: SessionId) => deleteSession(sessionId),
      deleteWorkspace: (workspaceId: string) => deleteWorkspace(workspaceId),
      addWorkspace: () => addWorkspace(),
      moveWorkspace: (workspaceId, beforeWorkspaceId) => moveWorkspace(workspaceId, beforeWorkspaceId),
      moveSession: (workspaceId, sessionId, beforeSessionId) =>
        moveSession(workspaceId, sessionId, beforeSessionId),
    },
  )
  ctx.effect(() => ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces',
    priority: -1,
    locale: NS,
    inject: face,
  }, GitSidebar)), 'git-tree: workspaces region')
}
