/**
 * The `sessions` tab: the Workspace → Session outline, with the three operations
 * the region is responsible for.
 *
 * Selecting a row goes through the `uiWorkspace` navigation service, starting a
 * Session goes through `startSession`, a rename is written into the Session's own
 * log, and removing a row is the Host's archive — the same actions the shell's
 * browser binds. Every one of them arrives through the injected face, so this
 * component holds no transport.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, ReactNode } from 'react'
import {
  IconCopyOutlineRegular, IconEditOutlineRegular, IconFolderCloseRegular, IconPlusOutlineRegular, IconProjectAddOutlineRegular,
  IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { dropSide, resolveDrop } from './sessions.ts'
import type { DragItem, DropAction, DropTarget, SessionRow, WorkspaceGroup } from './sessions.ts'

/**
 * What a drag is doing right now.
 *
 * The dragged item is held in a ref rather than in the drag payload: a drop reads
 * it directly, where `dataTransfer` only exposes data on `drop` and not on the
 * `dragover` that has to accept the drop in the first place. The payload is still
 * set, because a drag does not start without one.
 */
interface DragState {
  item: DragItem | null
  over: DropTarget | null
}

/** Whether two drop targets name the same thing, for the highlight. */
function sameTarget(left: DropTarget | null, right: DropTarget): boolean {
  if (left === null || left.kind !== right.kind) return false
  if (left.kind === 'workspace-list' || right.kind === 'workspace-list') return true
  if (left.kind === 'workspace' && right.kind === 'workspace') {
    return left.workspaceId === right.workspaceId
  }
  if (left.kind === 'session-list' && right.kind === 'session-list') {
    return left.workspaceId === right.workspaceId
  }
  if (left.kind === 'session' && right.kind === 'session') {
    return left.sessionId === right.sessionId
  }
  return false
}

/** The drag handlers every drop zone is given. */
interface DragProps {
  readonly drag: DragState
  readonly accept: (dragged: DragItem | null, target: DropTarget, order: readonly string[]) => boolean
  readonly mark: (item: DragItem | null, over: DropTarget | null) => void
  readonly drop: (target: DropTarget, order: readonly string[]) => void
}

/** The shared half of a draggable element's props. */
function dragHandlers(
  props: DragProps,
  item: DragItem,
  target: DropTarget,
  order: readonly string[],
): {
  readonly draggable: true
  readonly onDragStart: (event: ReactDragEvent<HTMLElement>) => void
  readonly onDragEnd: () => void
  readonly onDragOver: (event: ReactDragEvent<HTMLElement>) => void
  readonly onDrop: (event: ReactDragEvent<HTMLElement>) => void
} {
  return {
    draggable: true,
    onDragStart: (event) => {
      // The payload is what makes a drag start at all; the item itself is kept
      // beside it, because `dragover` cannot read the payload back.
      const transfer = event.dataTransfer
      if (transfer !== null) {
        transfer.setData('text/plain', item.kind === 'workspace' ? item.workspaceId : item.sessionId)
        transfer.effectAllowed = 'move'
      }
      props.mark(item, null)
    },
    onDragEnd: () => { props.mark(null, null) },
    onDragOver: (event) => {
      if (!props.accept(props.drag.item, target, order)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
      props.mark(props.drag.item, target)
    },
    onDrop: (event) => {
      event.preventDefault()
      event.stopPropagation()
      props.drop(target, order)
    },
  }
}

/** What a row needs from the panel. */
export interface RowActions {
  onOpen: (sessionId: SessionId) => void
  onRename: (sessionId: SessionId, title: string) => Promise<void>
  /** Branch the Session and open the branch. */
  onClone: (sessionId: SessionId) => Promise<void>
  onDelete: (sessionId: SessionId) => Promise<void>
}

/**
 * The label a row shows.
 *
 * A blank Session with no durable title is the New Session page, so it reads that
 * way — the same presentation the shell's browser gives it. The moment it carries
 * a title of its own, that title wins.
 * @param session - the row.
 * @param t - namespace-bound translate.
 * @returns the visible label.
 */
function labelledTitle(session: SessionRow, t: TranslateNS<'gitTree'>): string {
  return session.blank && !session.named ? t('session.new') : session.title
}

/** One Session row: a button, its hover actions, and its inline rename. */
function SessionRowItem({ session, workspaceId, order, t, actions, drag }: {
  session: SessionRow
  /** The Workspace the row is listed under, which is the only one it may move in. */
  workspaceId: string
  /** That Workspace's Session order, which is what a drop is resolved against. */
  order: readonly string[]
  t: TranslateNS<'gitTree'>
  actions: RowActions
  drag: DragProps
}): ReactNode {
  const target: DropTarget = { kind: 'session', workspaceId, sessionId: String(session.id) }
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title)
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  const labelled = labelledTitle(session, t)

  const begin = useCallback((): void => {
    setDraft(session.blank && !session.named ? '' : session.title)
    setFailure('')
    setEditing(true)
  }, [session.blank, session.named, session.title])

  const commit = useCallback((): void => {
    const title = draft.trim()
    setEditing(false)
    if (title === '' || title === labelled) return
    setBusy(true)
    void actions.onRename(session.id, title)
      .catch((reason: unknown) => {
        setFailure(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { setBusy(false) })
  }, [actions, draft, labelled, session.id])

  const clone = useCallback((): void => {
    setFailure('')
    setBusy(true)
    void actions.onClone(session.id)
      .catch((reason: unknown) => {
        setFailure(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { setBusy(false) })
  }, [actions, session.id])

  const remove = useCallback((): void => {
    setFailure('')
    setBusy(true)
    void actions.onDelete(session.id)
      .catch((reason: unknown) => {
        setFailure(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { setBusy(false) })
  }, [actions, session.id])

  return (
    <li className="gt-item">
      {editing ? (
        <input
          ref={input}
          className="gt-rename"
          value={draft}
          aria-label={t('session.rename')}
          placeholder={t('session.renamePlaceholder')}
          onChange={event => { setDraft(event.target.value) }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); commit() }
            if (event.key === 'Escape') { event.preventDefault(); setEditing(false) }
          }}
        />
      ) : (
        <div
          className="gt-session"
          data-active={session.active}
          data-busy={busy}
          data-session-status={session.status}
          data-session-id={String(session.id)}
          data-session-title={session.title}
          data-drop={sameTarget(drag.drag.over, target) ? 'true' : undefined}
          data-drop-side={dropSide(drag.drag.item, target, order)}
          {...dragHandlers(drag, { kind: 'session', workspaceId, sessionId: String(session.id) }, target, order)}
        >
          <button
            type="button"
            className="gt-session-open"
            aria-current={session.active ? 'page' : undefined}
            title={labelled}
            onClick={() => { actions.onOpen(session.id) }}
            onDoubleClick={begin}
          >
            {/* Drawn only while there is something to say — reading a Session
                clears its mark — and always said as well, because a colour and a
                spin carry nothing to a reader who cannot see them. */}
            {session.status === 'none'
              ? null
              : <span className="gt-session-mark" data-status={session.status} aria-hidden="true" />}
            <span className="gt-session-title">{labelled}</span>
            {session.status === 'none'
              ? null
              : <span className="gt-sr">{t(`session.status.${session.status}`)}</span>}
          </button>
          <span className="gt-row-actions">
            <button
              type="button"
              className="gt-icon-button"
              title={t('session.rename')}
              aria-label={t('session.rename')}
              onClick={begin}
            >
              <IconEditOutlineRegular />
            </button>
            <button
              type="button"
              className="gt-icon-button"
              title={t('session.clone')}
              aria-label={t('session.clone')}
              onClick={clone}
            >
              <IconCopyOutlineRegular />
            </button>
            <button
              type="button"
              className="gt-icon-button gt-danger"
              title={t('session.delete')}
              aria-label={t('session.delete')}
              onClick={remove}
            >
              <IconTrashOutlineRegular />
            </button>
          </span>
        </div>
      )}
      {failure === ''
        ? null
        : <p className="gt-note gt-error" data-git-row="action-failed">{t('session.actionFailed', { message: failure })}</p>}
    </li>
  )
}

/** One Workspace header: its title, and the actions that apply to the workspace. */
function WorkspaceHeader({ group, t, onNewSession, onDeleteWorkspace, drag, order }: {
  group: WorkspaceGroup
  t: TranslateNS<'gitTree'>
  onNewSession: (workspaceId?: string) => void
  onDeleteWorkspace: (workspaceId: string) => Promise<void>
  drag: DragProps
  /** The outline's Workspace order, which is what a drop is resolved against. */
  order: readonly string[]
}): ReactNode {
  const target: DropTarget = { kind: 'workspace', workspaceId: group.workspaceId }
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)
  // Deleting a Workspace is offered only once nothing is left in it: what the Host
  // does with a populated Workspace's Sessions is not this panel's call.
  const empty = group.sessions.length === 0

  const remove = useCallback((): void => {
    setFailure('')
    setBusy(true)
    void onDeleteWorkspace(group.workspaceId)
      .catch((reason: unknown) => {
        setFailure(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { setBusy(false) })
  }, [group.workspaceId, onDeleteWorkspace])

  return (
    <>
      <h3
        className="gt-workspace-title"
        title={group.path}
        data-empty={empty}
        data-busy={busy}
        data-drop={sameTarget(drag.drag.over, target) ? 'true' : undefined}
        data-drop-side={dropSide(drag.drag.item, target, order)}
        {...dragHandlers(drag, { kind: 'workspace', workspaceId: group.workspaceId }, target, order)}
      >
        <IconFolderCloseRegular className="gt-icon" />
        <span className="gt-name">{group.title}</span>
        <button
          type="button"
          className="gt-icon-button"
          title={t('session.new')}
          aria-label={`${t('session.new')} — ${group.title}`}
          onClick={() => { onNewSession(group.workspaceId) }}
        >
          <IconPlusOutlineRegular />
        </button>
        {empty
          ? (
            <button
              type="button"
              className="gt-icon-button gt-danger"
              title={t('workspace.delete')}
              aria-label={`${t('workspace.delete')} — ${group.title}`}
              onClick={remove}
            >
              <IconTrashOutlineRegular />
            </button>
          )
          : null}
      </h3>
      {failure === ''
        ? null
        : <p className="gt-note gt-error" data-git-row="action-failed">{t('session.actionFailed', { message: failure })}</p>}
    </>
  )
}

/** The Workspace → Session outline. */
export function SessionsView({
  groups, t, onNewSession, onDeleteWorkspace, onAddWorkspace, onMove, actions,
}: {
  groups: readonly WorkspaceGroup[]
  t: TranslateNS<'gitTree'>
  /** Starts a Session; without a Workspace it inherits the current or most recent one. */
  onNewSession: (workspaceId?: string) => void
  /** Removes a Workspace that has no Sessions left. */
  onDeleteWorkspace: (workspaceId: string) => Promise<void>
  /** Picks a directory and registers it as a Workspace. */
  onAddWorkspace: () => Promise<void>
  /** Performs one resolved drop; the panel turns it into one registry call. */
  onMove: (action: DropAction) => void
  actions: RowActions
}): ReactNode {
  const drag = useRef<DragState>({ item: null, over: null })
  const workspaceOrder = groups.map(group => group.workspaceId)
  const [, redraw] = useState(0)
  const mark = useCallback((item: DragItem | null, over: DropTarget | null): void => {
    drag.current = { item, over }
    redraw((value) => value + 1)
  }, [])
  const accept = useCallback((dragged: DragItem | null, target: DropTarget, order: readonly string[]): boolean => {
    // Only a drop that would move something accepts the drag, so the pointer never
    // shows a drop it is going to refuse.
    return resolveDrop(dragged, target, order) !== null
  }, [])
  const drop = useCallback((target: DropTarget, order: readonly string[]): void => {
    const action = resolveDrop(drag.current.item, target, order)
    mark(null, null)
    if (action !== null) onMove(action)
  }, [mark, onMove])
  const [addFailure, setAddFailure] = useState('')
  const add = useCallback((): void => {
    setAddFailure('')
    void onAddWorkspace().catch((reason: unknown) => {
      setAddFailure(reason instanceof Error ? reason.message : String(reason))
    })
  }, [onAddWorkspace])

  return (
    <div
      className="gt-sessions"
      data-git-view="sessions"
      data-drop={sameTarget(drag.current.over, { kind: 'workspace-list' }) ? 'true' : undefined}
      onDragOver={(event) => {
        // The outline's own space takes a Workspace to the end of the order.
        if (!accept(drag.current.item, { kind: 'workspace-list' }, workspaceOrder)) return
        event.preventDefault()
        mark(drag.current.item, { kind: 'workspace-list' })
      }}
      onDrop={(event) => { event.preventDefault(); drop({ kind: 'workspace-list' }, workspaceOrder) }}
    >
      <div className="gt-actions">
        <button
          type="button"
          className="gt-action"
          data-git-action="add-workspace"
          title={t('workspace.add')}
          onClick={add}
        >
          <IconProjectAddOutlineRegular className="gt-icon" />
          <span className="gt-action-label">{t('workspace.add')}</span>
        </button>
      </div>
      {addFailure === ''
        ? null
        : <p className="gt-note gt-error" data-git-row="action-failed">{t('session.actionFailed', { message: addFailure })}</p>}
      {groups.length === 0
        ? <p className="gt-note" data-git-row="no-sessions">{t('sessions.empty')}</p>
        : null}
      {groups.map(group => {
        const order = group.sessions.map(session => String(session.id))
        return (
        <section className="gt-workspace" key={group.workspaceId}>
          <WorkspaceHeader
            group={group}
            t={t}
            onNewSession={onNewSession}
            onDeleteWorkspace={onDeleteWorkspace}
            drag={{ drag: drag.current, accept, mark, drop }}
            order={workspaceOrder}
          />
          {group.sessions.length === 0
            ? <p className="gt-note" data-git-row="empty-group">{t('sessions.emptyGroup')}</p>
            : (
              <ul
                className="gt-list"
                data-drop={sameTarget(drag.current.over, { kind: 'session-list', workspaceId: group.workspaceId }) ? 'true' : undefined}
                onDragOver={(event) => {
                  // A Workspace's row space takes one of its Sessions to the end.
                  const target: DropTarget = { kind: 'session-list', workspaceId: group.workspaceId }
                  if (!accept(drag.current.item, target, order)) return
                  event.preventDefault()
                  mark(drag.current.item, target)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  drop({ kind: 'session-list', workspaceId: group.workspaceId }, order)
                }}
              >
                {group.sessions.map(session => (
                  <SessionRowItem
                    key={String(session.id)}
                    session={session}
                    workspaceId={group.workspaceId}
                    order={order}
                    t={t}
                    actions={actions}
                    drag={{ drag: drag.current, accept, mark, drop }}
                  />
                ))}
              </ul>
            )}
        </section>
        )
      })}
    </div>
  )
}
