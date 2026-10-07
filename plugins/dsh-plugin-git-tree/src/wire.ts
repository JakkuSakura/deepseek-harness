/**
 * Wire types shared by the Host collector and the browser tab.
 *
 * This module carries no runtime import so that the browser bundle inlines it
 * without pulling anything into the module graph: the Client only ever
 * `import type`s from here.
 */

/** What git said about one path. */
export type GitChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'

/** One changed path with its line counts. */
export interface GitChange {
  /** POSIX path relative to the Session workspace root. */
  readonly path: string
  /** The simplified status; the two porcelain columns are folded into one. */
  readonly kind: GitChangeKind
  /** Lines added, or null when the file is binary or has no count yet. */
  readonly insertions: number | null
  /** Lines removed, or null when the file is binary or has no count yet. */
  readonly deletions: number | null
  /** True when git reported the path as binary. */
  readonly binary: boolean
  /**
   * True when the path is a submodule.
   *
   * A submodule is a gitlink: the superproject records a commit, not contents, so
   * it is a directory the outline can open rather than a file it can count. Git's
   * own line counts for one are a placeholder for that single recorded commit,
   * which is why they are reported as absent here.
   */
  readonly submodule: boolean
}

/** Aggregate counts over the changed set. */
export interface GitTotals {
  readonly files: number
  readonly insertions: number
  readonly deletions: number
  readonly binary: number
}

/** One whole answer: where the repository is and what changed inside the workspace. */
export interface GitSnapshot {
  /** Absolute repository top-level directory (`git rev-parse --show-toplevel`). */
  readonly repositoryRoot: string
  /** Absolute Session working directory the counts were scoped to. */
  readonly workspaceRoot: string
  /** Changed paths, sorted by path. */
  readonly changes: readonly GitChange[]
  readonly totals: GitTotals
  /** True when the endpoint's file cap dropped changes from the tail. */
  readonly truncated: boolean
  /** Epoch milliseconds at which the Host answered. */
  readonly generatedAt: number
}

/** The `/api/git-tree` response body. */
export type GitStatsResponse =
  | { readonly status: 'ok'; readonly snapshot: GitSnapshot }
  | { readonly status: 'no-repository' }
  | { readonly status: 'error'; readonly code: string; readonly message: string }

/** One path's unified diff, as the `/api/git-tree/diff` route answers. */
export interface GitDiffView {
  /** The path as asked for: relative to the Session workspace root. */
  readonly path: string
  /** Unified diff text; empty when the path has nothing to show. */
  readonly diff: string
  /** True when the endpoint's byte cap cut the text short. */
  readonly truncated: boolean
  /** True when the path is untracked, so the whole file reads as added. */
  readonly untracked: boolean
}

/** The `/api/git-tree/diff` response body. */
export type GitDiffResponse =
  | { readonly status: 'ok'; readonly view: GitDiffView }
  | { readonly status: 'no-repository' }
  | { readonly status: 'error'; readonly code: string; readonly message: string }

/** How one path's committed bytes came back. */
export type GitBlobResponse =
  | {
    readonly status: 'ok'
    /** Base64 of the bytes, because the route answers JSON like every other. */
    readonly base64: string
    /** Media type guessed from the path, so the client can build a data URL. */
    readonly mime: string
  }
  | { readonly status: 'no-repository' }
  | {
    readonly status: 'error'
    readonly code: string
    readonly message: string
  }
