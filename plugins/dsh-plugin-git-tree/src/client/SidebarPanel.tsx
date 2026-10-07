/**
 * The left sidebar's Workspaces region, replaced by a tabbed git panel.
 *
 * The shell declares `sidebar.workspaces` and `ui-workspace` fills it at the
 * default priority; this registration sits at `priority: -1`, and a `single`
 * slot renders its **lowest** live priority, so this panel is the occupant while
 * the workspace browser is shadowed — not unregistered, so its child slots stay
 * declared for the plugins that contribute to them, and it resumes untouched
 * when this plugin unloads.
 *
 * Root-scope slots carry no Session identity, so the panel derives the
 * foreground Session the same way `ui-workspace` does: the row the main view
 * retains (`retainedBy.mainView`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  GuideArtworkFiles, IconPlusOutlineRegular, PathLabel,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { GitStatsResponse } from '../wire.ts'
import { buildChangeIndex, changeFolders, childPath } from './changes.ts'
import { FilesView } from './FilesView.tsx'
import { groupSessions } from './sessions.ts'
import type { DropAction } from './sessions.ts'
import { SessionsView } from './SessionsView.tsx'
import type { RowActions } from './SessionsView.tsx'
import { WorktreeView } from './WorktreeView.tsx'
import { sameLevel } from './levels.ts'
import { rateLabel } from './liverate.ts'
import { liveRateSnapshot } from './pillrate.ts'
import type { LevelState } from './levels.ts'
import type { GitSidebarFace } from './face.ts'
import type {} from './locales.ts'

/** The panel's composed props: the shell's region share, the injected face, and copy. */
export type GitSidebarProps =
  & PropsRuntime<'sidebar.workspaces'>
  & GitSidebarFace
  & PropsLocale<'gitTree'>

/** The views this panel switches between; the Session outline leads. */
type PanelTab = 'sessions' | 'worktree' | 'files'

/** Every tab in strip order. */
/**
 * How often the git tabs re-read the working tree.
 *
 * They poll rather than offering a reload button, because the tree changes
 * without the panel knowing. Ticks are skipped while a read is still out, so this
 * is a floor on the interval rather than a promise of exactly one read a second.
 */
const REFRESH_MS = 1000

const TABS: readonly { id: PanelTab, label: 'tab.sessions' | 'tab.worktree' | 'tab.files' }[] = [
  { id: 'sessions', label: 'tab.sessions' },
  { id: 'worktree', label: 'tab.worktree' },
  { id: 'files', label: 'tab.files' },
]

/**
 * The Session the main view currently shows.
 *
 * `retainedBy.mainView` is the reference source the main view holds while a
 * Session occupies it; `ui-workspace` identifies the current Session by exactly
 * this count.
 * @param sessions - the Session list snapshot.
 * @returns the foreground Session row, or undefined when none is retained.
 */
function currentSession(sessions: SessionListState): SessionSummary | undefined {
  for (const id of sessions.ids) {
    const row = sessions.byId[id]
    if (row !== undefined && (row.retainedBy.mainView ?? 0) > 0) return row
  }
  return undefined
}

/**
 * A signal source that survives React's double-invoked development mount: the
 * disposer aborts, and the next request mints a fresh controller instead of
 * reusing an aborted one.
 * @returns a getter for the current request signal.
 */
function useLiveSignal(): () => AbortSignal {
  const ref = useRef<AbortController | null>(null)
  useEffect(() => () => {
    ref.current?.abort()
    ref.current = null
  }, [])
  return useCallback(() => {
    if (ref.current === null || ref.current.signal.aborted) ref.current = new AbortController()
    return ref.current.signal
  }, [])
}

/** The git half of the status bar: how many files moved and by how much. */
/**
 * The cumulative output tokens a Session reports, whichever projection carries them.
 *
 * Read by field rather than by projection key: `outputTokens` is the contract
 * (`TokenUsageProjection`), while the key it is registered under is a detail of
 * whichever plugin computes it.
 * @param values - the Session summary's projection values.
 * @returns the count, or null when nothing reports one.
 */
/**
 * The stream rate, drawn only once it can say something.
 *
 * The label carries its own unit — bytes while text is arriving, tokens once a step
 * has reported — so it is rendered as it comes rather than through a translated
 * "N tok/s" template, which would be wrong for half the values it can hold.
 */
function StreamRateNote(): ReactNode {
  const label = rateLabel(liveRateSnapshot())
  if (label === null) return null
  return (
    <span className="gt-rate" data-stream-rate={label}>
      {label}
    </span>
  )
}

function GitStatus({ index, t }: { index: ReturnType<typeof buildChangeIndex>, t: TranslateNS<'gitTree'> }): ReactNode {
  if (index.status === 'loading') return <span className="gt-status-note">{t('files.loading')}</span>
  if (index.status === 'no-repository') return <span className="gt-status-note">{t('worktree.noRepository')}</span>
  if (index.status === 'error') return <span className="gt-status-note gt-error">{index.message}</span>
  return (
    <>
      <span className="gt-status-note">{t('worktree.summary', { count: index.totals.files })}</span>
      <span className="gt-counts">
        {index.totals.insertions > 0 ? <span className="gt-add">{`+${String(index.totals.insertions)}`}</span> : null}
        {index.totals.deletions > 0 ? <span className="gt-del">{`−${String(index.totals.deletions)}`}</span> : null}
      </span>
    </>
  )
}

/**
 * The tabbed git panel for the sidebar's Workspaces region.
 * @param props - the shell's region share, the injected face, and the copy share.
 * @returns the rail icon while collapsed, otherwise the tab strip and active view.
 */
export function GitSidebar(props: GitSidebarProps): ReactNode {
  const { wide, expandSidebar, useSessions, useWorkspaces, useSessionStatus, t, list, stats } = props
  const liveSignal = useLiveSignal()
  // Two primitive selections, so neither subscription churns on a new object.
  const sessionId = useSessions(sessions => currentSession(sessions)?.id)
  const cwd = useSessions(sessions => currentSession(sessions)?.cwd) ?? ''
  // Snapshot references are stable between changes, so these select the whole
  // collection without churning: both stores republish only on a real mutation.
  const sessionRows = useSessions(sessions => sessions.byId)

  // The rolling output-token rate: sampled on a clock, because a rate needs time as
  // much as it needs a count. The timer runs whether or not the count moves, which
  // is what lets the figure fall towards zero once a Session stops producing.
  // A plain refresh, so the note re-reads the live figure. The measurement lives in
  // the pill's observer, which samples per chunk and owns the clock; a second clock
  // here is what let the sidebar and the pill show different numbers.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => { setTick(tick => tick + 1) }, 1000)
    return () => { clearInterval(timer) }
  }, [])
  const workspaceViews = useWorkspaces(snapshot => snapshot)
  // Live status per Session: what the row's mark is drawn from.
  const statuses = useSessionStatus(snapshot => snapshot)
  const groups = useMemo(
    () => groupSessions({
      workspaces: workspaceViews.items,
      sessions: sessionRows,
      archived: workspaceViews.archivedSessionIds,
      activeId: sessionId,
      statuses,
    }),
    [workspaceViews, sessionRows, sessionId, statuses],
  )

  const [tab, setTab] = useState<PanelTab>('sessions')
  const [response, setResponse] = useState<GitStatsResponse | null>(null)
  const [levels, setLevels] = useState<Readonly<Record<string, LevelState>>>({})
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const [revision, setRevision] = useState(0)
  // Which submodules are opened as folders. What they hold is the same level
  // state the Files tab uses, keyed by absolute path.
  const [submodules, setSubmodules] = useState<ReadonlySet<string>>(() => new Set<string>())

  // The reload effect reads the expansion set at gesture time without depending
  // on it, so opening a directory never re-reads the whole tree.
  const expandedRef = useRef<readonly string[]>([])
  expandedRef.current = expanded

  // Non-zero while a stats read is outstanding; see the poll below.
  const pendingRef = useRef(0)

  const loadLevel = useCallback((path: string): void => {
    if (sessionId === undefined) return
    const signal = liveSignal()
    // Only a directory with nothing to show yet reports loading. A refresh keeps
    // the listing it already has on screen until the new one arrives, so a poll
    // tick never flashes a placeholder over a tree that is already up.
    setLevels(previous => previous[path] === undefined
      ? { ...previous, [path]: { kind: 'loading' } }
      : previous)
    void list(sessionId, path, signal).then((result) => {
      if (signal.aborted) return
      setLevels((previous) => {
        const next: LevelState = result.ok
          ? { kind: 'ready', entries: result.value.entries, truncated: result.value.truncated }
          : { kind: 'failed', code: result.error.code, message: result.error.message }
        // A listing that did not change keeps the object it had, so a tick that
        // found nothing new re-renders nothing.
        return sameLevel(previous[path], next) ? previous : { ...previous, [path]: next }
      })
    })
  }, [list, liveSignal, sessionId])

  useEffect(() => {
    if (cwd === '') {
      setLevels({})
      setExpanded([])
      return
    }
    // Only the Files tab draws the tree, so a poll on another tab has no reason to
    // re-list every open directory. Switching to it re-runs this.
    if (tab !== 'files') return
    loadLevel(cwd)
    for (const path of expandedRef.current) loadLevel(path)
  }, [cwd, revision, tab, loadLevel])

  useEffect(() => {
    if (sessionId === undefined) {
      setResponse(null)
      pendingRef.current = 0
      return
    }
    const signal = liveSignal()
    let live = true
    const ticket = pendingRef.current + 1
    pendingRef.current = ticket
    void stats(sessionId, signal)
      .then((body) => { if (live && !signal.aborted) setResponse(body) })
      // Only the newest read clears the guard: a superseded one must not report
      // the newer read as finished.
      .finally(() => { if (pendingRef.current === ticket) pendingRef.current = 0 })
    return () => { live = false }
  }, [stats, sessionId, revision, liveSignal])

  const index = useMemo(() => buildChangeIndex(response), [response])

  // The files tree lists lazily, so it would otherwise open fully collapsed and
  // show nothing about the changes the other two tabs are about. Opening it
  // seeds the expansion with the folders a change lives under — once per
  // Session and workspace, so a folder the user then collapses stays collapsed.
  // Deliberately not keyed on the poll's revision: a tick must not re-open a
  // folder the user just closed.
  const seededRef = useRef<string>('')
  useEffect(() => {
    if (tab !== 'files' || cwd === '') return
    const key = cwd
    if (seededRef.current === key) return
    seededRef.current = key
    const folders = changeFolders(index.changes).map(folder => childPath(cwd, folder))
    if (folders.length === 0) return
    setExpanded(previous => [...new Set([...previous, ...folders])])
    for (const path of folders) loadLevel(path)
  }, [tab, cwd, revision, index, loadLevel])

  // The working tree moves without the panel, so the git tabs re-read it on a
  // timer. Nothing polls while the sidebar is collapsed, while the document is
  // hidden, or while a previous read is still out. The Sessions tab is driven by
  // store signals instead, so it is left alone.
  useEffect(() => {
    if (!wide || tab === 'sessions') return
    const timer = setInterval(() => {
      if (pendingRef.current !== 0) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      setRevision(value => value + 1)
    }, REFRESH_MS)
    return () => { clearInterval(timer) }
  }, [wide, tab])

  const onToggle = useCallback((path: string): void => {
    const opening = !expandedRef.current.includes(path)
    setExpanded(previous => previous.includes(path)
      ? previous.filter(value => value !== path)
      : [...previous, path])
    if (opening) loadLevel(path)
  }, [loadLevel])

  // Opening a submodule lists the directory it is, through the Files tab's own
  // loader. It used to read the repository *inside* it and show that as changes,
  // which is what made a clean submodule look like an empty folder.
  const onOpenSubmodule = useCallback((path: string): void => {
    setSubmodules((previous) => new Set(previous).add(path))
    loadLevel(childPath(cwd, path))
  }, [cwd, loadLevel])

  const submodulesRef = useRef(submodules)
  submodulesRef.current = submodules

  const onCloseSubmodule = useCallback((path: string): void => {
    setSubmodules((previous) => {
      const next = new Set(previous)
      next.delete(path)
      return next
    })
  }, [])

  const onOpen = useCallback((path: string): void => {
    if (sessionId === undefined) return
    props.open(sessionId, path)
  }, [props, sessionId])

  // The Worktree tab is a list of changes, so a row there opens the change. The
  // Files tab is a tree of everything, so a row there opens the file.
  const onOpenDiff = useCallback((path: string): void => {
    if (sessionId === undefined) return
    props.openDiff(sessionId, path)
  }, [props, sessionId])

  const onSelectSession = useCallback((target: SessionId): void => {
    props.openSession(target)
  }, [props])

  const onNewSession = useCallback((workspaceId?: string): void => {
    props.newSession(workspaceId)
  }, [props])

  const onDeleteWorkspace = useCallback((workspaceId: string): Promise<void> => {
    return props.deleteWorkspace(workspaceId)
  }, [props])

  const onAddWorkspace = useCallback((): Promise<void> => props.addWorkspace(), [props])

  // One resolved drop becomes one registry move: both orders are addressed the
  // same way — place this before that, or at the end when there is no anchor.
  const onMove = useCallback((action: DropAction): void => {
    if (action.kind === 'move-workspace') {
      void props.moveWorkspace(action.workspaceId, action.beforeWorkspaceId)
      return
    }
    void props.moveSession(action.workspaceId, action.sessionId as SessionId, action.beforeSessionId as SessionId | undefined)
  }, [props])

  const rowActions: RowActions = useMemo(() => ({
    onOpen: onSelectSession,
    onRename: (sessionId, title) => props.renameSession(sessionId, title),
    onClone: (sessionId) => props.cloneSession(sessionId),
    onDelete: (sessionId) => props.deleteSession(sessionId),
  }), [onSelectSession, props])

  if (!wide) {
    return (
      <div className="gt-rail" data-git-panel="rail">
        {/* The shell's own New Session button is hidden by this panel's stylesheet,
            so the rail has to keep offering one. */}
        <button
          type="button"
          className="gt-rail-button"
          title={t('session.new')}
          aria-label={t('session.new')}
          onClick={() => { props.newSession() }}
        >
          <IconPlusOutlineRegular size={20} />
        </button>
        <button
          type="button"
          className="gt-rail-button"
          title={t('panel.label')}
          aria-label={t('panel.label')}
          onClick={expandSidebar}
        >
          <GuideArtworkFiles size={20} />
        </button>
      </div>
    )
  }

  const tree = { root: cwd, levels, expanded, index, t, onToggle, onOpen }

  return (
    <div className="gt-panel" data-git-panel="wide">
      {/* The path leads the panel: this region is mounted directly under the brand,
          so the first row of the panel is the row under the logo. */}
      <div className="gt-status" data-git-status={index.status}>
        {cwd === ''
          ? <span className="gt-status-note">{t('files.noWorkspace')}</span>
          : <PathLabel path={cwd} className="gt-status-path" />}
        {tab === 'sessions' ? null : <GitStatus index={index} t={t} />}
        <StreamRateNote />
      </div>

      <div className="gt-tabs" role="tablist" aria-label={t('panel.label')}>
        {TABS.map(entry => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            className="gt-tab"
            aria-selected={tab === entry.id}
            data-active={tab === entry.id}
            onClick={() => { setTab(entry.id) }}
          >
            {t(entry.label)}
          </button>
        ))}
      </div>

      <div className="gt-scroll" role="tabpanel">
        {tab === 'sessions'
          ? (
            <SessionsView
              groups={groups}
              t={t}
              onNewSession={onNewSession}
              onDeleteWorkspace={onDeleteWorkspace}
              onAddWorkspace={onAddWorkspace}
              onMove={onMove}
              actions={rowActions}
            />
          )
          : null}
        {tab === 'worktree'
          ? (
            <WorktreeView
              index={index}
              t={t}
              onOpen={onOpenDiff}
              submodules={submodules}
              onOpenSubmodule={onOpenSubmodule}
              onCloseSubmodule={onCloseSubmodule}
              files={tree}
            />
          )
          : null}
        {tab === 'files' ? <FilesView tree={tree} /> : null}
      </div>
    </div>
  )
}
