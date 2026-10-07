/**
 * Pure folds for the `sessions` tab.
 *
 * The panel shadows the shell's Workspaces browser, so it has to reproduce the
 * one thing that browser is for: the Workspace → Session outline. Everything here
 * is a fold over snapshots the framework hooks already publish, which keeps the
 * component free of subscription machinery and the rules testable.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /**
     * Held for the moment a rename is in flight. A reference source is a
     * reference-count label, so the panel declares its own rather than borrowing
     * the Workspace browser's.
     */
    gitTreePanelOperation: unknown
  }
}

/** One Session as a row. */
export interface SessionRow {
  readonly id: SessionId
  /** Host-projected label: durable title, then project basename, then the id. */
  readonly title: string
  /** Whether a durable title exists yet, i.e. whether the Session has been named. */
  readonly named: boolean
  /** A reusable blank Session, i.e. the New Session page. */
  readonly blank: boolean
  /**
   * What the row's mark shows.
   *
   * Three states, in the order they are decided: work in flight, work waiting on
   * the reader, and everything else. The last of those is not "finished" in any
   * strict sense — a Session nobody has started reads the same way — but it is the
   * only other thing a reader needs to know at a glance.
   */
  readonly status: SessionMark
  /** Host running state, drawn as a dot. */
  readonly running: boolean
  /** The Session the main view currently shows. */
  readonly active: boolean
}

/** One Workspace and the Sessions accounted to it. */
export interface WorkspaceGroup {
  readonly workspaceId: string
  readonly title: string
  readonly path: string
  readonly sessions: readonly SessionRow[]
}

/** Everything the outline is folded from. */
/**
 * What a Session row's mark says.
 *
 * `none` is a state, not an absence: a Session that finished and has been read has
 * nothing to say, and a mark that stays lit for it stops meaning anything.
 */
export type SessionMark = 'running' | 'input' | 'draft' | 'unread' | 'none'

/**
 * The slice of one Session's live status this fold reads.
 *
 * It carries `running` too, but the list summary's own field is the authority for
 * that: the status store reconciles its copy *from* the summary, so it can lag it,
 * and the summary is what the row has in hand anyway. This adds the two states the
 * summary does not carry — a pending interaction and an unread completion.
 */
export interface SessionMarkInput {
  readonly running?: boolean | undefined
  readonly pendingInteraction?: unknown
  readonly completionUnread?: boolean | undefined
}

/**
 * Decide a Session's mark, in the order the states outrank each other.
 *
 * Waiting on the reader wins: a Session that asked a question is stopped until it
 * is answered, so that is the thing worth saying. Work in flight is next. Then
 * `completionUnread` — a Session that finished with something the reader has not
 * looked at yet. Everything else is `none`: the mark is cleared by reading, so it
 * keeps meaning something.
 * @param running - the list summary's own running state, which leads.
 * @param status - the Session's live status, when the store has one.
 * @returns the mark.
 */
export function sessionMarkOf(
  running: boolean,
  status: SessionMarkInput | undefined,
  draft = false,
): SessionMark {
  if (status?.pendingInteraction !== undefined) return 'input'
  if (running || status?.running === true) return 'running'
  // The reader's own unsent input outranks an unread completion: it is the one of the
  // two they can act on without remembering anything.
  if (draft) return 'draft'
  if (status?.completionUnread === true) return 'unread'
  return 'none'
}

export interface SessionGroupingInput {
  /** Workspace rows in registry order. */
  readonly workspaces: readonly WorkspaceView[]
  /** The Session list's `byId` map. */
  readonly sessions: Readonly<Record<SessionId, SessionSummary>>
  /** Sessions the user archived; they leave the outline entirely. */
  readonly archived: readonly SessionId[]
  /** The foreground Session, or undefined when the main view holds none. */
  readonly activeId: SessionId | undefined
  /** Live status per Session, when the caller has it. */
  readonly statuses?: ReadonlyMap<string, SessionMarkInput> | undefined

  /** Sessions holding unsent input, which get their own mark. */
  readonly drafts?: ReadonlySet<string>
}

/**
 * Fold the Workspace registry and the Session list into the outline.
 *
 * Every Workspace is kept, including one with no Sessions left, because an empty
 * Workspace is exactly the one this tab offers to delete — and its header is also
 * where a new Session is started. A Session is dropped when it is archived,
 * belongs to a subagent rather than to the outline, or has no row in the list yet.
 * @param input - the snapshots to fold.
 * @returns the groups to render, in Workspace order, each Session in the manual order its Workspace records.
 */
export function groupSessions(input: SessionGroupingInput): WorkspaceGroup[] {
  const archived = new Set<string>(input.archived.map(String))
  const groups: WorkspaceGroup[] = []
  for (const workspace of input.workspaces) {
    const sessions: SessionRow[] = []
    for (const sessionId of workspace.sessionIds) {
      const summary = input.sessions[sessionId]
      if (summary === undefined) continue
      if (summary.origin === 'subagent') continue
      if (archived.has(String(sessionId))) continue
      sessions.push({
        status: sessionMarkOf(
          summary.running,
          input.statuses?.get(String(sessionId)),
          input.drafts?.has(String(sessionId)) === true,
        ),
        id: sessionId,
        title: summary.displayTitle,
        named: summary.title !== undefined,
        blank: summary.blank,
        running: summary.running,
        active: input.activeId !== undefined && String(input.activeId) === String(sessionId),
      })
    }
    groups.push({
      workspaceId: String(workspace.workspaceId),
      title: workspace.title,
      path: workspace.path,
      sessions,
    })
  }
  return groups
}

/** What a drag is carrying. */
export type DragItem =
  | { readonly kind: 'workspace', readonly workspaceId: string }
  | { readonly kind: 'session', readonly workspaceId: string, readonly sessionId: string }

/** What a drag is currently over. */
export type DropTarget =
  | { readonly kind: 'workspace', readonly workspaceId: string }
  | { readonly kind: 'session', readonly workspaceId: string, readonly sessionId: string }
  /** The outline's own space: a Workspace dropped here goes to the end. */
  | { readonly kind: 'workspace-list' }
  /** One Workspace's row space: a Session dropped here goes to that Workspace's end. */
  | { readonly kind: 'session-list', readonly workspaceId: string }

/** What a drop should move, or nothing when the drop means nothing. */
export type DropAction =
  | { readonly kind: 'move-workspace', readonly workspaceId: string, readonly beforeWorkspaceId?: string }
  | { readonly kind: 'move-session', readonly workspaceId: string, readonly sessionId: string, readonly beforeSessionId?: string }

/**
 * The anchor that lands a dragged item in another item's slot.
 *
 * The registry move is always "before this one", which is why a drop has to know
 * which way the drag is going: dropping onto the row **below** is a move *down*,
 * and "before the row below" is where the item already is — so the drag appears to
 * do nothing at all. Moving down therefore anchors on whatever follows the target
 * (and appends when nothing does), which is what puts the item in the target's
 * place rather than above it.
 * @param draggedId - the item being dragged.
 * @param targetId - the item it was dropped on.
 * @param order - the dragged list's current order.
 * @returns the anchor id, or undefined to append.
 */
function anchorFor(draggedId: string, targetId: string, order: readonly string[]): string | undefined {
  const from = order.indexOf(draggedId)
  const to = order.indexOf(targetId)
  if (from === -1 || to === -1 || from > to) return targetId
  const next = order[to + 1]
  return next === undefined || next === draggedId ? undefined : next
}

/**
 * Which edge of the target a drop lands on, for the mark a reader sees.
 * @param dragged - the item being dragged.
 * @param over - what the pointer is over.
 * @param order - the dragged list's current order.
 * @returns the edge, or undefined when the drop means nothing.
 */
export function dropSide(
  dragged: DragItem | null,
  over: DropTarget,
  order: readonly string[],
): 'before' | 'after' | undefined {
  if (dragged === null) return undefined
  if (over.kind === 'workspace-list' || over.kind === 'session-list') return 'after'
  if (dragged.kind === 'workspace') {
    if (over.kind !== 'workspace' || over.workspaceId === dragged.workspaceId) return undefined
    return anchorFor(dragged.workspaceId, over.workspaceId, order) === over.workspaceId ? 'before' : 'after'
  }
  if (over.kind !== 'session' || over.workspaceId !== dragged.workspaceId) return undefined
  if (over.sessionId === dragged.sessionId) return undefined
  return anchorFor(dragged.sessionId, over.sessionId, order) === over.sessionId ? 'before' : 'after'
}

/**
 * Decide what a drop does, if anything.
 *
 * The registry orders both lists, and both of its moves are "place this before
 * that, or at the end when there is no anchor" — so a drop is resolved into one of
 * those two calls rather than into a position. Three drops are refused, and all
 * three matter:
 *
 * - A Session is only ever moved **within its own Workspace**. The registry can
 *   move one between Workspaces, but a Session's workspace is what its working
 *   directory is resolved from, so that is a different act than arranging.
 * - A drop on the dragged item itself would be a no-op at best and a lost row at
 *   worst: the item is already where the drop would put it.
 * - A kind dropped on the other kind means nothing, and is refused rather than
 *   guessed at.
 * @param dragged - the item being dragged, or null when nothing is.
 * @param over - what the pointer is over.
 * @param order - the dragged list's current order, which says which way the drag goes.
 * @returns the move to perform, or null.
 */
export function resolveDrop(
  dragged: DragItem | null,
  over: DropTarget,
  order: readonly string[] = [],
): DropAction | null {
  if (dragged === null) return null
  if (dragged.kind === 'workspace') {
    if (over.kind === 'workspace-list') return { kind: 'move-workspace', workspaceId: dragged.workspaceId }
    if (over.kind !== 'workspace' || over.workspaceId === dragged.workspaceId) return null
    return {
      kind: 'move-workspace',
      workspaceId: dragged.workspaceId,
      beforeWorkspaceId: anchorFor(dragged.workspaceId, over.workspaceId, order),
    }
  }
  if (over.kind === 'session-list') {
    if (over.workspaceId !== dragged.workspaceId) return null
    return {
      kind: 'move-session',
      workspaceId: dragged.workspaceId,
      sessionId: dragged.sessionId,
    }
  }
  if (over.kind !== 'session' || over.workspaceId !== dragged.workspaceId) return null
  if (over.sessionId === dragged.sessionId) return null
  return {
    kind: 'move-session',
    workspaceId: dragged.workspaceId,
    sessionId: dragged.sessionId,
    beforeSessionId: anchorFor(dragged.sessionId, over.sessionId, order),
  }
}
