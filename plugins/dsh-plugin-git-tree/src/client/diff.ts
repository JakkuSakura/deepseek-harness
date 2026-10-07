/**
 * The `gitdiff` resource protocol: the address of one changed path, the read
 * behind it, and the line classification its body draws.
 *
 * A diff address is a file address under a different URI host. The shared grammar
 * already component-encodes the Session id and every path segment, so this module
 * swaps the host rather than growing a second encoder that would have to agree
 * with the first one forever.
 */
import { parseFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { readJsonRoute } from './route.ts'
import type { GitDiffView } from '../wire.ts'

/**
 * What the Changes tab draws.
 *
 * The failure lives *in* the value rather than in the resource's own error
 * branch. A resource frame's failure is a `RemoteFailure`, which is a union of
 * `RemoteError` class instances that only a generated Remote produces — this
 * route is a plain HTTP fetch, so it has no such value to hand back. Modelling
 * the failure as data keeps the protocol honest: the tab is live, and what it is
 * showing is the current answer, which may be that the answer could not be read.
 */
export interface GitDiffValue extends GitDiffView {
  /** Set when the last read failed; `diff` is then empty. */
  readonly failure: { readonly code: string, readonly message: string } | null
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** One changed path's unified diff, or why it could not be read. */
    gitdiff: GitDiffValue
  }
}

/** The protocol this plugin owns: the URI host of every diff address. */
export const GIT_DIFF_PROTOCOL = 'gitdiff'

/**
 * The Host route in the document-relative form the browser addresses it by: the
 * Web shell injects `<base href="./">`, so no leading slash.
 */
export const GIT_DIFF_ROUTE = 'api/git-tree/diff'

/** Where the shared grammar names the file protocol. */
const FILE_PREFIX = 'dsh-resource://file/'
const DIFF_PREFIX = `dsh-resource://${GIT_DIFF_PROTOCOL}/`

/**
 * Build the address of one path's diff inside a Session.
 * @param sessionId - the Session whose workspace resolves the path.
 * @param path - absolute or workspace-relative path, as the file grammar spells it.
 * @returns the `dsh-resource://gitdiff/session/<sessionId>/<path>` address.
 */
export function gitDiffAddress(sessionId: string, path: string): string {
  const file = sessionFileAddress(sessionId, path)
  return file.startsWith(FILE_PREFIX) ? `${DIFF_PREFIX}${file.slice(FILE_PREFIX.length)}` : file
}

/**
 * Read a diff address back into its parts.
 * @param address - a candidate address.
 * @returns the parts, or null when the string is not a Session-scoped diff address.
 */
export function parseGitDiffAddress(address: string): { sessionId: SessionId, path: string } | null {
  if (!address.startsWith(DIFF_PREFIX)) return null
  const parsed = parseFileAddress(`${FILE_PREFIX}${address.slice(DIFF_PREFIX.length)}`)
  if (parsed === undefined || parsed.scope !== 'session') return null
  return { sessionId: parsed.sessionId as SessionId, path: parsed.path }
}

/**
 * The value for a path whose diff could not be read.
 * @param path - the path the address named, or the address itself.
 * @param code - a short machine-readable reason.
 * @param message - the reason as copy.
 * @returns a value the tab draws as its failure line.
 */
export function unreadableDiff(path: string, code: string, message: string): GitDiffValue {
  return { path, diff: '', truncated: false, untracked: false, failure: { code, message } }
}

/** {@link unreadableDiff} under the name the route narrowing reads better with. */
const failed = unreadableDiff

/**
 * The plain-file address behind one diff address.
 *
 * The two are the same grammar under different hosts, so opening the file itself
 * is a host swap — which is what hands a reader to the product's own renderer
 * rather than a second one written here.
 * @param address - a diff address, or anything else.
 * @returns the file address, or undefined when the address is not a diff.
 */
export function fileAddressOfDiff(address: string): string | undefined {
  if (!address.startsWith(DIFF_PREFIX)) return undefined
  return `${FILE_PREFIX}${address.slice(DIFF_PREFIX.length)}`
}

/**
 * The chip text for one diff address: the file it names.
 * @param address - a diff address, or anything else.
 * @returns the path's last segment, or a name for an address this plugin cannot read.
 */
export function titleOfDiffAddress(address: string): string {
  const target = parseGitDiffAddress(address)
  if (target === null) return GIT_DIFF_PROTOCOL
  const cut = target.path.replace(/[/\\]+$/, '')
  const index = cut.lastIndexOf('/')
  return index === -1 ? cut : cut.slice(index + 1)
}

/** Read one route body into the value the tab draws. */
function asValue(path: string, body: unknown): GitDiffValue {
  if (typeof body !== 'object' || body === null) {
    return failed(path, 'malformed', 'the route answered no object')
  }
  const record = body as { status?: unknown, view?: unknown, code?: unknown, message?: unknown }
  if (record.status === 'ok' && typeof record.view === 'object' && record.view !== null) {
    const view = record.view as Partial<GitDiffView>
    if (typeof view.path === 'string' && typeof view.diff === 'string') {
      return {
        path: view.path,
        diff: view.diff,
        truncated: view.truncated === true,
        untracked: view.untracked === true,
        failure: null,
      }
    }
  }
  if (record.status === 'no-repository') {
    return failed(path, 'no-repository', 'this workspace is not a repository')
  }
  if (record.status === 'error') {
    return failed(
      path,
      typeof record.code === 'string' ? record.code : 'error',
      typeof record.message === 'string' ? record.message : 'the diff could not be read',
    )
  }
  return failed(path, 'malformed', 'the route answered an unknown body')
}

/**
 * Read one path's unified diff from the Host.
 * @param sessionId - the Session owning the workspace.
 * @param path - the changed path, relative to the workspace root.
 * @param signal - request lifetime.
 * @returns the current value, with `failure` set rather than thrown.
 */
export async function readGitDiff(
  sessionId: SessionId,
  path: string,
  signal: AbortSignal,
): Promise<GitDiffValue> {
  const query = new URLSearchParams({ sessionId: String(sessionId), path })
  try {
    const response = await fetch(`${GIT_DIFF_ROUTE}?${query.toString()}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal,
    })
    const read = await readJsonRoute('the diff route', response)
    if (!read.ok) return failed(path, read.code, read.message)
    return asValue(path, read.body)
  } catch (error: unknown) {
    if (signal.aborted) return failed(path, 'aborted', 'the read was aborted')
    return failed(path, 'transport', error instanceof Error ? error.message : String(error))
  }
}

/**
 * One row of a side-by-side reading of the same diff.
 *
 * A unified diff is a single column in which a removal is stated and then, below
 * it, its replacement. Side by side is the same information stated across: the
 * removal on the left, its replacement on the right, and a context line on both.
 * Headers are the one thing that cannot be split, so they span.
 */
export interface SplitRow {
  /** Full-width rows — file headers, hunk headers, metadata — carry their text here. */
  readonly text: string
  /** The padding kind, or `pair` when the row has a left and a right cell. */
  readonly kind: DiffLineKind | 'pair'
  readonly left: DiffLine | null
  readonly right: DiffLine | null
}

/** A row that spans both columns. */
function spanning(line: DiffLine): SplitRow {
  return { text: line.text, kind: line.kind, left: null, right: null }
}

/**
 * Read a unified diff as rows of two columns.
 *
 * Within one hunk git states every removal before the addition that replaces it,
 * so a run of removals is paired with the run of additions that follows: the first
 * removal against the first addition, and so on. Runs of unequal length leave the
 * shorter side blank rather than shifting the pairing, which is what makes a
 * rewritten block line up instead of drifting.
 * @param text - the diff text, with or without a trailing newline.
 * @returns one row per drawn line, in order.
 */
export function splitRows(text: string): SplitRow[] {
  const lines = diffLines(text)
  const rows: SplitRow[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    if (line.kind === 'del') {
      // Collect the removal run, then the addition run that answers it.
      const removals: DiffLine[] = []
      while (index < lines.length && lines[index]?.kind === 'del') {
        const removal = lines[index]
        if (removal !== undefined) removals.push(removal)
        index += 1
      }
      const additions: DiffLine[] = []
      while (index < lines.length && lines[index]?.kind === 'add') {
        const addition = lines[index]
        if (addition !== undefined) additions.push(addition)
        index += 1
      }
      const height = Math.max(removals.length, additions.length)
      for (let row = 0; row < height; row += 1) {
        rows.push({
          text: '',
          kind: 'pair',
          left: removals[row] ?? null,
          right: additions[row] ?? null,
        })
      }
      continue
    }
    index += 1
    // An addition with no removal ahead of it stands alone on the right.
    if (line.kind === 'add') {
      rows.push({ text: '', kind: 'pair', left: null, right: line })
      continue
    }
    // Context belongs to both columns; everything else spans.
    if (line.kind === 'context') {
      rows.push({ text: line.text, kind: 'pair', left: line, right: line })
      continue
    }
    rows.push(spanning(line))
  }
  return rows
}

/** How one line of a unified diff is drawn. */
export type DiffLineKind = 'file' | 'meta' | 'hunk' | 'add' | 'del' | 'context' | 'nonewline'

/** One line of a unified diff, classified. */
export interface DiffLine {
  readonly kind: DiffLineKind
  /** The line with its trailing newline removed. */
  readonly text: string
}

/** Headers git writes about the file rather than its content. */
const META_PREFIXES = [
  'index ',
  'new file mode ',
  'deleted file mode ',
  'old mode ',
  'new mode ',
  'similarity index ',
  'rename from ',
  'rename to ',
  'copy from ',
  'copy to ',
  'Binary files ',
  'GIT binary patch',
]

/**
 * Classify a unified diff into the lines a view draws.
 *
 * The order of the tests is the whole trick: `+++`/`---` are file headers that
 * begin with a content marker, and a `\` line is git's note that the file has no
 * trailing newline rather than a change.
 * @param text - the diff text, with or without a trailing newline.
 * @returns one entry per line, in order.
 */
export function diffLines(text: string): DiffLine[] {
  if (text === '') return []
  const raw = text.endsWith('\n') ? text.slice(0, -1) : text
  return raw.split('\n').map((line) => {
    if (line.startsWith('diff --git ')) return { kind: 'file' as const, text: line }
    if (line.startsWith('@@')) return { kind: 'hunk' as const, text: line }
    if (line.startsWith('+++') || line.startsWith('---')) return { kind: 'meta' as const, text: line }
    if (META_PREFIXES.some(prefix => line.startsWith(prefix))) return { kind: 'meta' as const, text: line }
    if (line.startsWith('\\')) return { kind: 'nonewline' as const, text: line }
    if (line.startsWith('+')) return { kind: 'add' as const, text: line }
    if (line.startsWith('-')) return { kind: 'del' as const, text: line }
    return { kind: 'context' as const, text: line }
  })
}
