/** One directory's listing state, shared by the tree view and the region that owns it. */
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'

/** What one absolute directory path currently holds. */
export type LevelState =
  | { kind: 'loading' }
  | { kind: 'ready', entries: readonly WorkspaceDirectoryEntry[], truncated: boolean }
  | { kind: 'failed', code: string, message: string }

/** Whether two listing entries describe the same file. */
function sameEntry(left: WorkspaceDirectoryEntry, right: WorkspaceDirectoryEntry): boolean {
  return left.name === right.name && left.type === right.type && left.size === right.size
}

/**
 * Whether a freshly read listing says exactly what the held one already says.
 *
 * The panel re-lists every open directory on a poll tick. Each read arrives as a
 * new array of new objects, so without this the tree would re-render once a second
 * on a directory that never changed — which is what made the panel flicker.
 * @param left - the listing already held, if the directory has been read before.
 * @param right - the listing just read.
 * @returns true when the two are interchangeable and the held one can stand.
 */
export function sameLevel(left: LevelState | undefined, right: LevelState): boolean {
  if (left === undefined || left.kind !== right.kind) return false
  if (left.kind === 'loading') return true
  if (left.kind === 'failed' && right.kind === 'failed') {
    return left.code === right.code && left.message === right.message
  }
  if (left.kind !== 'ready' || right.kind !== 'ready') return false
  if (left.truncated !== right.truncated) return false
  if (left.entries.length !== right.entries.length) return false
  for (let index = 0; index < left.entries.length; index += 1) {
    const held = left.entries[index]
    const read = right.entries[index]
    if (held === undefined || read === undefined) return false
    if (!sameEntry(held, read)) return false
  }
  return true
}
