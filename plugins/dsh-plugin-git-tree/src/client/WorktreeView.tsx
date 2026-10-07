/**
 * The `worktree` tab: the working tree's uncommitted changes, grouped by folder.
 *
 * The change set arrives flat, with every path relative to the workspace root;
 * this view folds it into the directory outline the reader actually navigates by.
 * A folder row carries the counts aggregated over everything beneath it, so a
 * collapsed folder still says how much moved inside. The `files` tab is the whole
 * workspace tree; this one is only what changed.
 */
import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { FileTypeIcon, IconFolderCloseRegular, IconFolderOpenRegular, classifyFileType } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { childPath, foldChangeTree, statusLetter } from './changes.ts'
import { FilesView } from './FilesView.tsx'
import type { ChangeIndex, ChangeNode, DirectoryCounts } from './changes.ts'
import type { FilesTree } from './FilesView.tsx'


/** A row's `+n −m` pair; a binary leaf reports itself instead. */
function Counts({ insertions, deletions }: { insertions: number, deletions: number }): ReactNode {
  if (insertions === 0 && deletions === 0) return null
  return (
    <span className="gt-counts">
      {insertions > 0 ? <span className="gt-add">{`+${String(insertions)}`}</span> : null}
      {deletions > 0 ? <span className="gt-del">{`−${String(deletions)}`}</span> : null}
    </span>
  )
}

/**
 * One folder row and, while open, its children.
 *
 * A submodule is a folder whose contents live in another repository: opening it
 * asks for that repository's change set rather than reading children the fold
 * already had. Its own state line stands in for the counts, which describe nothing
 * a gitlink records.
 */
function FolderRow({
  node, t, collapsed, onToggle, onOpen, onOpenSubmodule, onCloseSubmodule, submodules, files,
}: {
  node: ChangeNode
  t: TranslateNS<'gitTree'>
  collapsed: ReadonlySet<string>
  onToggle: (node: ChangeNode) => void
  onOpen: (path: string) => void
  onOpenSubmodule: (path: string) => void
  onCloseSubmodule: (path: string) => void
  submodules: ReadonlySet<string>
  /** The Files tab's machinery, reused so a submodule lists like any folder. */
  files: FilesTree
}): ReactNode {
  const isSubmodule = node.submodule === true
  // Ordinary folders start open, because the fold already holds their children. A
  // submodule's listing is read when it is opened, so it is open exactly while that
  // read is held.
  const open = isSubmodule ? submodules.has(node.path) : !collapsed.has(node.path)
  const counts: DirectoryCounts = node.counts ?? { insertions: 0, deletions: 0, files: 0 }
  const children = isSubmodule ? [] : (node.children ?? [])
  return (
    <li className="gt-item" data-git-folder={node.path} data-git-submodule={isSubmodule ? 'true' : undefined}>
      <button
        type="button"
        className="gt-row"
        aria-expanded={open}
        title={node.path}
        onClick={() => {
          if (!isSubmodule) { onToggle(node); return }
          if (!open) onOpenSubmodule(node.path)
          else onCloseSubmodule(node.path)
        }}
      >
        {open ? <IconFolderOpenRegular className="gt-icon" /> : <IconFolderCloseRegular className="gt-icon" />}
        <span className="gt-name">{node.name}</span>
        {isSubmodule
          ? <span className="gt-submodule">{t('worktree.submodule')}</span>
          : <Counts insertions={counts.insertions} deletions={counts.deletions} />}
        {isSubmodule ? null : <span className="gt-dir-files">{String(counts.files)}</span>}
      </button>
      {open
        ? (
          <>
            {/* A submodule is a directory, so opening it lists what is in it —
                the same view the Files tab uses, started inside the submodule
                while paths stay relative to the workspace. Showing its *changes*
                instead read as an empty folder whenever its checkout was clean,
                which is the usual state of a submodule whose pointer moved. */}
            {isSubmodule
              ? (
                <div className="gt-level gt-submodule-body">
                  <FilesView
                    tree={{
                      ...files,
                      start: childPath(files.root, node.path),
                      // Opened the Worktree way — as a change — rather than the way
                      // the Files tab opens one, because that is the tab this is in.
                      onOpen,
                    }}
                  />
                </div>
              )
              : null}
            <ul className="gt-level" hidden={isSubmodule}>
              {children.map((child: ChangeNode) => (
                <ChangeRow
                  key={child.path}
                  node={child}
                  t={t}
                  collapsed={collapsed}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  onOpenSubmodule={onOpenSubmodule}
                  onCloseSubmodule={onCloseSubmodule}
                  submodules={submodules}
                  files={files}
                />
              ))}
            </ul>
          </>
        )
        : null}
    </li>
  )
}

/** One changed file. */
function FileRow({ node, t, onOpen }: {
  node: ChangeNode
  t: TranslateNS<'gitTree'>
  onOpen: (path: string) => void
}): ReactNode {
  const change = node.change
  if (change === undefined) return null
  return (
    <li className="gt-item" data-git-file={node.path}>
      <button
        type="button"
        className="gt-row"
        title={node.path}
        onClick={() => { onOpen(node.path) }}
      >
        <FileTypeIcon kind={classifyFileType(node.name)} size={16} className="gt-file-icon" />
        <span className="gt-name">{node.name}</span>
        <span className="gt-badge" data-kind={change.kind}>{statusLetter(change)}</span>
        {change.binary
          ? <span className="gt-bin">{t('binary')}</span>
          : <Counts insertions={change.insertions ?? 0} deletions={change.deletions ?? 0} />}
      </button>
    </li>
  )
}

/** One node of either kind. */
function ChangeRow(props: {
  node: ChangeNode
  t: TranslateNS<'gitTree'>
  collapsed: ReadonlySet<string>
  onToggle: (node: ChangeNode) => void
  onOpen: (path: string) => void
  onOpenSubmodule: (path: string) => void
  onCloseSubmodule: (path: string) => void
  submodules: ReadonlySet<string>
  files: FilesTree
}): ReactNode {
  return props.node.kind === 'directory'
    ? <FolderRow {...props} />
    : <FileRow node={props.node} t={props.t} onOpen={props.onOpen} />
}

/** The folded change outline and its three non-list states. */
export function WorktreeView({ index, t, onOpen, submodules, onOpenSubmodule, onCloseSubmodule, files }: {
  index: ChangeIndex
  t: TranslateNS<'gitTree'>
  onOpen: (path: string) => void
  /** The submodule paths currently opened as folders. */
  submodules: ReadonlySet<string>
  /** Ask for one submodule's listing, which is what opens it. */
  onOpenSubmodule: (path: string) => void
  /** Forget one submodule's listing, closing it again. */
  onCloseSubmodule: (path: string) => void
  /** The Files tab's listing state, which a submodule folder is rendered from. */
  files: FilesTree
}): ReactNode {
  // Folders start open: a change set is normally small enough to read at once.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const onToggle = useCallback((node: ChangeNode): void => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (!next.delete(node.path)) next.add(node.path)
      return next
    })
  }, [])
  const collapsedRef = useRef(collapsed)
  collapsedRef.current = collapsed

  if (index.status === 'loading') return <p className="gt-note" data-git-row="loading">{t('files.loading')}</p>
  if (index.status === 'no-repository') return <p className="gt-note" data-git-row="no-repository">{t('worktree.noRepository')}</p>
  if (index.status === 'error') return <p className="gt-note gt-error" data-git-row="error">{index.message}</p>
  if (index.changes.length === 0) return <p className="gt-note" data-git-row="clean">{t('worktree.empty')}</p>

  const nodes = foldChangeTree(index.changes)
  return (
    <ul className="gt-list" data-git-view="worktree">
      {nodes.map(node => (
        <ChangeRow
          key={node.path}
          node={node}
          t={t}
          collapsed={collapsed}
          onToggle={onToggle}
          onOpen={onOpen}
          onOpenSubmodule={onOpenSubmodule}
          onCloseSubmodule={onCloseSubmodule}
          submodules={submodules}
          files={files}
        />
      ))}
      {index.truncated ? <li className="gt-note">{t('worktree.truncated')}</li> : null}
    </ul>
  )
}
