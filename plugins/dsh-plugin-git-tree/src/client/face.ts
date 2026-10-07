/**
 * The panel's asynchronous half: directory listing over the `workspaceFiles`
 * Remote namespace, the git counts over the Host's authenticated
 * `/api/git-tree` route, and opening a file through the right Sidebar's resource
 * controller.
 *
 * The region is root-scoped, so nothing here holds a Session: the component
 * passes the identity it derived from the Session list, and the Remote and the
 * route both need it because the Host resolves the workspace root from it. The
 * component never touches transport — it calls `list` / `stats` / `open`, so the
 * Remote carrier, the document-relative route, and the `dsh-resource://file/…`
 * grammar all stay properties of this module.
 */
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceDirectoryListing } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { gitDiffAddress } from './diff.ts'
import { readJsonRoute } from './route.ts'
import type { GitBlobResponse, GitStatsResponse } from '../wire.ts'

/**
 * The Host route in the document-relative form the browser addresses it by: the
 * Web shell injects `<base href="./">`, so no leading slash — the same shape
 * `@deepseek-ai/dsh-session-log-export` uses for `/api/session.export`.
 */
export const GIT_TREE_ROUTE = 'api/git-tree'
/** The committed-bytes route, for a change a text diff can only call binary. */
const GIT_BLOB_ROUTE = 'api/git-tree/blob'

/** The panel's injected business face, as the region component receives it. */
export interface GitSidebarFace {
  /**
   * List one directory's direct children.
   * @param sessionId - Session owning the directory tree.
   * @param path - absolute directory path.
   * @param signal - request lifetime.
   */
  readonly list: (
    sessionId: SessionId,
    path: string,
    signal: AbortSignal,
  ) => Promise<RemoteResult<WorkspaceDirectoryListing>>
  /**
   * Read one Session workspace's git change counts.
   * @param sessionId - Session whose workspace is measured.
   * @param signal - request lifetime.
   * @returns the endpoint's body, or a synthesized failure when the read itself failed.
   */
  readonly stats: (sessionId: SessionId, signal: AbortSignal, submodule?: string) => Promise<GitStatsResponse>
  /**
   * Read one path's committed bytes, for a change a text diff can only call binary.
   * @param sessionId - Session whose workspace resolves the path.
   * @param path - workspace-relative path.
   * @param signal - request lifetime.
   * @returns a data URL of the bytes, or a reason there are none.
   */
  readonly previousImage: (
    sessionId: SessionId,
    path: string,
    signal: AbortSignal,
  ) => Promise<{ readonly url: string } | { readonly failure: string }>
  /**
   * Open one workspace file as a resource.
   * @param sessionId - Session whose workspace resolves the path.
   * @param path - absolute or workspace-relative file path.
   */
  readonly open: (sessionId: SessionId, path: string) => void
  /**
   * Open one path's changes in the right Sidebar.
   *
   * The Worktree tab lists changes, so its rows open the diff; the Files tab
   * lists the tree, so its rows open the file.
   * @param sessionId - Session owning the workspace.
   * @param path - the changed path, relative to the workspace root.
   */
  readonly openDiff: (sessionId: SessionId, path: string) => void
  /**
   * Select a Session and show its Conversation — the `uiWorkspace` navigation
   * action the shell's own browser uses.
   * @param sessionId - the Session to display.
   */
  readonly openSession: (sessionId: SessionId) => void
  /**
   * Start a new Session in a Workspace — `uiWorkspace.startSession`, the action
   * behind the shell's own New Session control.
   * @param workspaceId - explicit target; absent inherits the current or most recent Workspace.
   */
  readonly newSession: (workspaceId?: string) => void
  /**
   * Write a Session's title through its own log, the way the shell's rename does.
   * @param sessionId - the Session to retitle.
   * @param title - the new title.
   * @returns completion; rejects with the Host's reason.
   */
  readonly renameSession: (sessionId: SessionId, title: string) => Promise<void>
  /**
   * Branch a Session; the Host copies its transcript to the latest completed turn.
   * @param sessionId - the Session to copy.
   * @returns completion; rejects with the Host's reason.
   */
  readonly cloneSession: (sessionId: SessionId) => Promise<void>
  /**
   * Remove a Session from the browser.
   *
   * This is the Host's archive: the Session leaves every list and can be restored
   * with `uiWorkspace.unarchiveSession`, which the shell's browser offers. It is
   * not a deletion of the Session log.
   * @param sessionId - the Session to remove.
   * @returns completion; rejects while the Session still has running work.
   */
  readonly deleteSession: (sessionId: SessionId) => Promise<void>
  /**
   * Remove a Workspace from the registry.
   *
   * Offered only for a Workspace with no Sessions left, because what the Host does
   * with a populated Workspace's Sessions is not this panel's call to make.
   * @param workspaceId - the Workspace to remove.
   * @returns completion; rejects with the Host's reason.
   */
  readonly deleteWorkspace: (workspaceId: string) => Promise<void>
  /**
   * Pick a directory and register it as a Workspace.
   *
   * The region this panel shadows owned the add-Workspace action, so it has to own
   * it too: with the last Workspace deleted there is otherwise nothing to start a
   * Session in.
   * @returns completion; a cancelled picker resolves without creating anything.
   */
  readonly addWorkspace: () => Promise<void>
  /**
   * Move a Workspace within the registry's order.
   * @param workspaceId - the Workspace to move.
   * @param beforeWorkspaceId - the Workspace it lands before; omitted appends.
   * @returns completion.
   */
  readonly moveWorkspace: (workspaceId: string, beforeWorkspaceId?: string) => Promise<void>
  /**
   * Move a Session within its own Workspace's order.
   * @param workspaceId - the owning Workspace.
   * @param sessionId - the Session to move.
   * @param beforeSessionId - the Session it lands before; omitted appends.
   * @returns completion.
   */
  readonly moveSession: (
    workspaceId: string,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ) => Promise<void>
  /**
   * Close every tab of the right Sidebar that will close.
   *
   * The controller lists no tabs, so this walks them the way the repeated close
   * gesture does; the guide, which cannot close, is left as the default page.
   * @returns completion once the walk has settled.
   */
  readonly closeAllTabs: () => Promise<void>
}

/**
 * Reject a body that is not one of the three declared shapes.
 * @param body - the parsed JSON body.
 * @returns the body when it is recognized, otherwise an error response.
 */
function readResponse(body: unknown): GitStatsResponse {
  if (typeof body !== 'object' || body === null) {
    return { status: 'error', code: 'malformed', message: 'the Host returned no JSON object' }
  }
  const status = (body as { status?: unknown }).status
  if (status === 'ok' || status === 'no-repository' || status === 'error') {
    return body as GitStatsResponse
  }
  return { status: 'error', code: 'malformed', message: 'the Host returned an unrecognized body' }
}

/**
 * Bind the panel's face to one Client Remote, the git route, and the resource
 * opener.
 * @param remote - the Client Remote face carrying the `workspaceFiles` namespace.
 * @param openAddress - opens a `dsh-resource://` address; a no-op while no Sidebar is mounted.
 * @param sessionActions - the Workspace browser's navigation and Session operations; every member is a no-op while it is not loaded.
 * @returns the Slot `inject` factory: the face out.
 */
export function createGitSidebarFace(
  remote: ClientRemote,
  openAddress: (address: string) => void,
  closeAllTabs: () => Promise<void>,
  sessionActions: {
    readonly openSession: (sessionId: SessionId) => void
    readonly newSession: (workspaceId?: string) => void
    readonly renameSession: (sessionId: SessionId, title: string) => Promise<void>
    readonly cloneSession: (sessionId: SessionId) => Promise<void>
    readonly deleteSession: (sessionId: SessionId) => Promise<void>
    readonly deleteWorkspace: (workspaceId: string) => Promise<void>
    readonly addWorkspace: () => Promise<void>
    readonly moveWorkspace: (workspaceId: string, beforeWorkspaceId?: string) => Promise<void>
    readonly moveSession: (workspaceId: string, sessionId: SessionId, beforeSessionId?: SessionId) => Promise<void>
  },
): () => GitSidebarFace {
  return (): GitSidebarFace => ({
    list: (sessionId, path, signal) => remote.workspaceFiles.list(sessionId, path, signal),
    async stats(sessionId, signal, submodule) {
      const query = new URLSearchParams({ sessionId: String(sessionId) })
      // Naming a submodule scopes the same read to a directory inside the
      // workspace that is a repository of its own.
      if (submodule !== undefined) query.set('submodule', submodule)
      try {
        const response = await fetch(`${GIT_TREE_ROUTE}?${query.toString()}`, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          signal,
        })
        const read = await readJsonRoute('the git stats route', response)
        if (!read.ok) return { status: 'error', code: read.code, message: read.message }
        return readResponse(read.body)
      } catch (error: unknown) {
        if (signal.aborted) return { status: 'error', code: 'aborted', message: 'the read was aborted' }
        return {
          status: 'error',
          code: 'transport',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
    open: (sessionId, path) => { openAddress(sessionFileAddress(String(sessionId), path)) },
    openDiff: (sessionId, path) => { openAddress(gitDiffAddress(String(sessionId), path)) },
    openSession: (sessionId) => { sessionActions.openSession(sessionId) },
    newSession: (workspaceId) => { sessionActions.newSession(workspaceId) },
    renameSession: (sessionId, title) => sessionActions.renameSession(sessionId, title),
    cloneSession: (sessionId) => sessionActions.cloneSession(sessionId),
    deleteSession: (sessionId) => sessionActions.deleteSession(sessionId),
    deleteWorkspace: (workspaceId) => sessionActions.deleteWorkspace(workspaceId),
    async previousImage(sessionId, path, signal) {
      const query = new URLSearchParams({ sessionId: String(sessionId), path })
      try {
        const response = await fetch(`${GIT_BLOB_ROUTE}?${query.toString()}`, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          signal,
        })
        const read = await readJsonRoute('the committed bytes route', response)
        if (!read.ok) return { failure: read.message }
        const body = read.body as GitBlobResponse
        if (body.status === 'ok') return { url: `data:${body.mime};base64,${body.base64}` }
        if (body.status === 'no-repository') return { failure: 'no-repository' }
        // `no-previous` is the ordinary answer for an added or untracked path.
        return { failure: body.code === 'no-previous' ? 'no-previous' : body.message }
      } catch (reason: unknown) {
        if (signal.aborted) return { failure: 'aborted' }
        return { failure: reason instanceof Error ? reason.message : String(reason) }
      }
    },
    addWorkspace: () => sessionActions.addWorkspace(),
    moveWorkspace: (workspaceId, beforeWorkspaceId) => sessionActions.moveWorkspace(workspaceId, beforeWorkspaceId),
    moveSession: (workspaceId, sessionId, beforeSessionId) =>
      sessionActions.moveSession(workspaceId, sessionId, beforeSessionId),
    closeAllTabs: () => closeAllTabs(),
  })
}
