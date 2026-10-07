/**
 * The `files` tab: the Session workspace root listed one level at a time, with
 * git's change counts written onto the rows they belong to.
 *
 * A directory row aggregates its descendants' counts, so a collapsed subtree
 * still reports how much moved inside it. Rows are ordered directories first,
 * then by natural case-insensitive name — the endpoint's order is a listing
 * fact, this is the reader's.
 */
import type { ReactNode } from 'react'
import {
  FileTypeIcon, IconFolderCloseRegular, IconFolderOpenRegular, classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import { childPath, orderEntries, relativeToRoot, statusLetter } from './changes.ts'
import type { ChangeIndex } from './changes.ts'
import type { LevelState } from './levels.ts'

/** A row's `+n −m` pair, absent when neither side moved. */
function Counts({ insertions, deletions }: { insertions: number, deletions: number }): ReactNode {
  if (insertions === 0 && deletions === 0) return null
  return (
    <span className="gt-counts">
      {insertions > 0 ? <span className="gt-add">{`+${String(insertions)}`}</span> : null}
      {deletions > 0 ? <span className="gt-del">{`−${String(deletions)}`}</span> : null}
    </span>
  )
}

/** What every level and row shares. */
export interface FilesTree {
  readonly root: string
  /**
   * The absolute directory this view renders from; {@link root} when omitted.
   *
   * A submodule is listed by rendering this view again from inside it, while
   * `root` stays the workspace so the paths it opens are still workspace-relative —
   * which is what lets the Host find the repository that actually holds the file.
   */
  readonly start?: string
  readonly levels: Readonly<Record<string, LevelState>>
  readonly expanded: readonly string[]
  readonly index: ChangeIndex
  readonly t: TranslateNS<'gitTree'>
  readonly onToggle: (path: string) => void
  /** Opens one file by its workspace-relative path. */
  readonly onOpen: (relativePath: string) => void
}

/** Say why a directory could not be listed, in terms of the directory. */
function failureLine(t: TranslateNS<'gitTree'>, level: { code: string, message: string }): string {
  switch (level.code) {
    case 'workspace-file/not-found': return t('error.notFound')
    case 'workspace-file/outside-workspace': return t('error.outsideWorkspace')
    case 'workspace-file/not-directory': return t('error.notDirectory')
    default: return level.message
  }
}

/** One entry's row, and its children when it is an expanded directory. */
function TreeEntry({ parent, entry, tree }: { parent: string, entry: WorkspaceDirectoryEntry, tree: FilesTree }): ReactNode {
  const path = childPath(parent, entry.name)
  const relative = relativeToRoot(tree.root, path)
  const change = tree.index.byPath.get(relative)
  const counts = tree.index.byDirectory.get(relative)

  if (entry.type === 'directory') {
    const expanded = tree.expanded.includes(path)
    return (
      <li className="gt-item" data-git-entry="directory" data-git-path={path}>
        <button type="button" className="gt-row" aria-expanded={expanded} onClick={() => { tree.onToggle(path) }}>
          {expanded
            ? <IconFolderOpenRegular className="gt-icon" />
            : <IconFolderCloseRegular className="gt-icon" />}
          <span className="gt-name">{entry.name}</span>
          {counts !== undefined && counts.files > 0
            ? <Counts insertions={counts.insertions} deletions={counts.deletions} />
            : null}
          {counts !== undefined && counts.files > 0
            ? <span className="gt-dir-files">{String(counts.files)}</span>
            : null}
        </button>
        {expanded ? <ul className="gt-level"><TreeLevel path={path} tree={tree} /></ul> : null}
      </li>
    )
  }

  if (entry.type === 'file') {
    return (
      <li className="gt-item" data-git-entry="file" data-git-path={path}>
        <button type="button" className="gt-row" title={relative} onClick={() => { tree.onOpen(relative) }}>
          <FileTypeIcon kind={classifyFileType(entry.name)} size={16} className="gt-file-icon" />
          <span className="gt-name">{entry.name}</span>
          {change !== undefined
            ? <span className="gt-badge" data-kind={change.kind}>{statusLetter(change)}</span>
            : null}
          {change === undefined
            ? null
            : change.binary
              ? <span className="gt-bin">{tree.t('binary')}</span>
              : <Counts insertions={change.insertions ?? 0} deletions={change.deletions ?? 0} />}
        </button>
      </li>
    )
  }

  return (
    <li className="gt-item" data-git-entry="other" data-git-path={path}>
      <span className="gt-row gt-other" aria-disabled="true" title={tree.t('entry.other')}>
        <span className="gt-name">{entry.name}</span>
      </span>
    </li>
  )
}

/** One directory's rows: its state while listing, its entries once listed. */
function TreeLevel({ path, tree }: { path: string, tree: FilesTree }): ReactNode {
  const level = tree.levels[path]
  if (level === undefined || level.kind === 'loading') {
    return <li className="gt-note" data-git-row="loading">{tree.t('files.loading')}</li>
  }
  if (level.kind === 'failed') {
    return (
      <li className="gt-note gt-error" data-git-row="failed" data-git-code={level.code}>
        {failureLine(tree.t, level)}
      </li>
    )
  }
  if (level.entries.length === 0) {
    return <li className="gt-note" data-git-row="empty">{tree.t('files.empty')}</li>
  }
  return (
    <>
      {orderEntries(level.entries).map(entry => (
        <TreeEntry key={entry.name} parent={path} entry={entry} tree={tree} />
      ))}
      {level.truncated ? <li className="gt-note">{tree.t('files.truncated')}</li> : null}
    </>
  )
}

/** The annotated workspace tree. */
export function FilesView({ tree }: { tree: FilesTree }): ReactNode {
  if (tree.root === '') return <p className="gt-note" data-git-row="no-workspace">{tree.t('files.noWorkspace')}</p>
  return (
    <ul className="gt-list" data-git-view="files">
      <TreeLevel path={tree.start ?? tree.root} tree={tree} />
    </ul>
  )
}
