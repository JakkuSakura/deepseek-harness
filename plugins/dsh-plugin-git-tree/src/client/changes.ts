/**
 * Pure path and change-set folds for the browser half.
 *
 * No `node:path` and no Host import: everything here is a string fold the client
 * bundle inlines, so the tab adds no module-graph request.
 */
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { GitChange, GitStatsResponse, GitTotals } from '../wire.ts'

/** Aggregate counts attributed to one directory, its descendants included. */
export interface DirectoryCounts {
  insertions: number
  deletions: number
  files: number
}

/** The change set as the tab renders it. */
export interface ChangeIndex {
  status: 'loading' | 'ok' | 'no-repository' | 'error'
  /** The Host's diagnostic, for the `error` status. */
  message: string
  /** Changed files, in the Host's path order. */
  changes: readonly GitChange[]
  /** Keyed by workspace-relative POSIX path. */
  byPath: ReadonlyMap<string, GitChange>
  /** Keyed by workspace-relative directory path, `''` for the workspace root. */
  byDirectory: ReadonlyMap<string, DirectoryCounts>
  totals: GitTotals
  truncated: boolean
}

/** Counts of a working tree with nothing to report. */
const EMPTY_TOTALS: GitTotals = { files: 0, insertions: 0, deletions: 0, binary: 0 }

/** Normalize to POSIX separators. */
export function toPosix(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * Join a listed directory and one child name with `/`, whatever the parent's
 * separators: the Host resolves mixed separators, and the tree only needs a
 * stable key.
 * @param parent - absolute path of the listed directory.
 * @param name - the entry's basename.
 * @returns the child's absolute path.
 */
export function childPath(parent: string, name: string): string {
  return `${parent.replace(/[/\\]+$/, '')}/${name}`
}

/**
 * The path's form relative to the workspace root.
 * @param workspaceRoot - absolute Session working directory.
 * @param path - absolute path.
 * @returns the workspace-relative POSIX path, or `''` for the root itself.
 */
export function relativeToRoot(workspaceRoot: string, path: string): string {
  const root = toPosix(workspaceRoot).replace(/\/+$/, '')
  const target = toPosix(path)
  if (target === root) return ''
  return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : target
}

/**
 * The parent directory of a workspace-relative path.
 * @param path - workspace-relative POSIX path.
 * @returns the parent's workspace-relative path, `''` at the root.
 */
export function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

/** The single-letter status badge a changed row shows. */
export function statusLetter(change: GitChange): string {
  switch (change.kind) {
    case 'added': return 'A'
    case 'modified': return 'M'
    case 'deleted': return 'D'
    case 'renamed': return 'R'
    case 'copied': return 'C'
    case 'untracked': return 'U'
    case 'conflicted': return '!'
  }
}

/**
 * Fold one Host response into the index the tab draws, attributing each change's
 * counts to every directory on its path.
 * @param response - the endpoint's body, or null while the first read is in flight.
 * @returns the renderable index.
 */
export function buildChangeIndex(response: GitStatsResponse | null): ChangeIndex {
  const byPath = new Map<string, GitChange>()
  const byDirectory = new Map<string, DirectoryCounts>()
  const empty = (status: ChangeIndex['status'], message = ''): ChangeIndex => ({
    status, message, changes: [], byPath, byDirectory, totals: EMPTY_TOTALS, truncated: false,
  })
  if (response === null) return empty('loading')
  if (response.status === 'no-repository') return empty('no-repository')
  if (response.status === 'error') return empty('error', response.message)

  const { changes, totals, truncated } = response.snapshot
  for (const change of changes) {
    byPath.set(change.path, change)
    let directory = parentPath(change.path)
    for (;;) {
      const counts = byDirectory.get(directory) ?? { insertions: 0, deletions: 0, files: 0 }
      counts.insertions += change.insertions ?? 0
      counts.deletions += change.deletions ?? 0
      counts.files += 1
      byDirectory.set(directory, counts)
      if (directory === '') break
      directory = parentPath(directory)
    }
  }
  return { status: 'ok', message: '', changes, byPath, byDirectory, totals, truncated }
}

/** Natural, case-insensitive name order, so `file2` precedes `file10`. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Order one level's entries for display: directories first, then everything
 * else, each group by name. The endpoint's order is a listing fact; this is the
 * reader's.
 * @param entries - the listing as the endpoint returned it.
 * @returns a new array, directories first, then by name within each group.
 */
export function orderEntries(entries: readonly WorkspaceDirectoryEntry[]): WorkspaceDirectoryEntry[] {
  return [...entries].sort((left, right) => {
    const group = Number(right.type === 'directory') - Number(left.type === 'directory')
    return group !== 0 ? group : byName.compare(left.name, right.name)
  })
}

/** One node of the changed-file tree: a folder, or one changed file. */
export interface ChangeNode {
  /** Segment name: the folder or file name. */
  readonly name: string
  /** Workspace-relative POSIX path of this folder or file. */
  readonly path: string
  readonly kind: 'directory' | 'file'
  /** Folders only: counts aggregated over every changed file beneath. */
  readonly counts?: DirectoryCounts
  /** Folders only: the grouped entries, folders first, then files by name. */
  readonly children?: readonly ChangeNode[]
  /** Files only: the change this leaf stands for. */
  readonly change?: GitChange
  /**
   * Directories only: this directory is a submodule.
   *
   * Its change is the gitlink the superproject records, and its children come from
   * reading the submodule itself, which is why they are loaded rather than folded.
   */
  readonly submodule?: boolean
}

/** A directory while the tree is being assembled. */
interface ChangeFolder {
  readonly name: string
  readonly path: string
  readonly folders: Map<string, ChangeFolder>
  readonly files: ChangeNode[]
  /** Set when this directory is a submodule rather than a path changes pass through. */
  submodule?: GitChange
}

/** Sum a node list's changed files recursively. */
function tally(nodes: readonly ChangeNode[], totals: DirectoryCounts): void {
  for (const node of nodes) {
    if (node.change !== undefined) {
      totals.insertions += node.change.insertions ?? 0
      totals.deletions += node.change.deletions ?? 0
      totals.files += 1
    }
    if (node.children !== undefined) tally(node.children, totals)
  }
}

/**
 * Group a change set into a folder tree, so the `worktree` tab reads as a
 * directory outline instead of a list of full paths.
 *
 * A folder's path is relative to the workspace root, `''` being the root itself,
 * which is never a node; the returned array is the root's direct children.
 * @param changes - the change set, in any order.
 * @returns the tree, folders first then files, each group by natural name order.
 */
export function foldChangeTree(changes: readonly GitChange[]): ChangeNode[] {
  const root: ChangeFolder = { name: '', path: '', folders: new Map(), files: [] }
  for (const change of changes) {
    const segments = change.path.split('/').filter(segment => segment !== '')
    const fileName = segments.pop()
    if (fileName === undefined || fileName === '') continue
    // A submodule is one entry at a directory path: it becomes the directory, so
    // the outline shows it as the folder it is instead of a file with no contents.
    if (change.submodule === true) {
      const existing = root.folders.get(fileName)
      if (existing === undefined) {
        root.folders.set(fileName, {
          name: fileName,
          path: change.path,
          folders: new Map(),
          files: [],
          submodule: change,
        })
      } else {
        existing.submodule = change
      }
      continue
    }
    let folder = root
    for (const segment of segments) {
      let next = folder.folders.get(segment)
      if (next === undefined) {
        next = {
          name: segment,
          path: folder.path === '' ? segment : `${folder.path}/${segment}`,
          folders: new Map(),
          files: [],
        }
        folder.folders.set(segment, next)
      }
      folder = next
    }
    folder.files.push({ name: fileName, path: change.path, kind: 'file', change })
  }

  const build = (folder: ChangeFolder): ChangeNode[] => {
    const nodes: ChangeNode[] = []
    const folders = [...folder.folders.values()].sort((left, right) => byName.compare(left.name, right.name))
    for (const child of folders) {
      const children = build(child)
      const counts: DirectoryCounts = { insertions: 0, deletions: 0, files: 0 }
      tally(children, counts)
      // A submodule's own contents live in its repository, not here, so its
      // reported totals stay empty until the reader opens it.
      nodes.push({
        name: child.name,
        path: child.path,
        kind: 'directory',
        counts,
        children,
        ...child.submodule === undefined
          ? {}
          : { submodule: true, change: child.submodule },
      })
    }
    const files = [...folder.files].sort((left, right) => byName.compare(left.name, right.name))
    return [...nodes, ...files]
  }

  return build(root)
}

/**
 * Every folder a change set lives under, shallowest first.
 *
 * The `files` tab lists lazily, so an untouched tree opens fully collapsed and
 * shows none of the changes the other tabs are about. Seeding the expansion with
 * these folders opens exactly the paths worth looking at — and nothing else,
 * because a folder no change passes through stays shut.
 * @param changes - the change set.
 * @param limit - maximum folders returned, bounding the listings one open may trigger.
 * @returns workspace-relative folder paths, parents before children.
 */
export function changeFolders(changes: readonly GitChange[], limit = 60): string[] {
  const folders = new Set<string>()
  for (const change of changes) {
    let directory = parentPath(change.path)
    while (directory !== '') {
      if (folders.size >= limit) break
      folders.add(directory)
      directory = parentPath(directory)
    }
    if (folders.size >= limit) break
  }
  return [...folders].sort((left, right) => {
    const depth = left.split('/').length - right.split('/').length
    return depth !== 0 ? depth : left < right ? -1 : left > right ? 1 : 0
  })
}
