/**
 * Git collection for the Host half: locate the repository enclosing a Session
 * working directory, read the working tree's change set, and report per-file
 * line counts scoped to that directory.
 *
 * Every git command runs through the `subprocess` capability with a scrubbed
 * environment and bounded output; the repository's index, objects, work tree and
 * refs are only ever read. The parsers below are pure and exported so the
 * package's tests can drive them with recorded git output.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { GitChange, GitChangeKind, GitSnapshot } from '../wire.ts'

/** Milliseconds a git child gets to exit after termination starts. */
export const TERMINATE_GRACE_MS = 2_000
/** Retained stderr tail for diagnostics. */
const STDERR_TAIL_BYTES = 16 * 1024
/** Bytes of an untracked file sniffed for a NUL byte before it is counted as text. */
const BINARY_SNIFF_BYTES = 8_000
/** The `XY` codes git uses for an unmerged path. */
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** Settled git command facts; a nonzero exit is a result, not an exception. */
export interface GitRunResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  /** True when stdout exceeded the command's cap and lost its head. */
  readonly truncated: boolean
}

/** Per-command spawn facts. */
export interface GitRunOptions {
  readonly cwd: string
  readonly signal: AbortSignal
  /** In-memory stdout cap for this command, replacing the runner's limit. */
  readonly maxBytes?: number | undefined
}

/** Bounds every git command runs under. */
export interface GitLimits {
  readonly timeoutMs: number
  readonly outputMaxBytes: number
}

/** One path as `git status --porcelain=v1 -z` reported it. */
export interface StatusEntry {
  /** Repository-root-relative POSIX path. */
  readonly path: string
  /** The path the entry was renamed or copied from, when git reported one. */
  readonly oldPath: string | undefined
  readonly kind: GitChangeKind
  /** True when the staged (first) column carries the change. */
  readonly staged: boolean
}

/** One path as `git diff --numstat -z` reported it. */
export interface NumstatEntry {
  /** Repository-root-relative POSIX path (the new path for a rename). */
  readonly path: string
  readonly oldPath: string | undefined
  readonly insertions: number | null
  readonly deletions: number | null
  readonly binary: boolean
}

/**
 * Fold git's two porcelain columns into one change kind, preferring the staged
 * column the way `git status --short` reads left to right.
 * @param xy - the two-character status code.
 * @returns the simplified kind and whether the staged column carries it.
 */
export function kindFromPorcelain(xy: string): { kind: GitChangeKind, staged: boolean } {
  if (xy === '??') return { kind: 'untracked', staged: false }
  if (CONFLICT_CODES.has(xy)) return { kind: 'conflicted', staged: true }
  const stagedCode = xy[0] ?? ' '
  const worktreeCode = xy[1] ?? ' '
  const staged = stagedCode !== ' ' && stagedCode !== '?'
  const code = staged ? stagedCode : worktreeCode
  switch (code) {
    case 'A': return { kind: 'added', staged }
    case 'D': return { kind: 'deleted', staged }
    case 'R': return { kind: 'renamed', staged }
    case 'C': return { kind: 'copied', staged }
    default: return { kind: 'modified', staged }
  }
}

/**
 * Parse `git status --porcelain=v1 -z -uall`.
 *
 * Each record is `XY <path>` terminated by NUL; a rename or copy record is
 * followed by one extra NUL-terminated field holding the original path.
 * @param stdout - the command's raw stdout.
 * @returns one entry per reported path.
 */
export function parsePorcelainStatus(stdout: string): StatusEntry[] {
  const tokens = stdout.split('\0')
  const entries: StatusEntry[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined || token.length < 4) continue
    const xy = token.slice(0, 2)
    const path = token.slice(3)
    if (path === '') continue
    let oldPath: string | undefined
    if (xy[0] === 'R' || xy[0] === 'C') oldPath = tokens[index + 1]
    if (oldPath !== undefined) index += 1
    const folded = kindFromPorcelain(xy)
    entries.push({ path, oldPath, kind: folded.kind, staged: folded.staged })
  }
  return entries
}

/**
 * Parse `git diff --numstat -z`.
 *
 * A record is `insertions<TAB>deletions<TAB>path`, NUL-terminated, with `-` in
 * place of a count for a binary file. A rename or copy record leaves the path
 * field empty and follows it with the original and new paths as two further
 * NUL-terminated fields.
 * @param stdout - the command's raw stdout.
 * @returns one entry per reported path.
 */
/**
 * Read the paths `git diff --raw -z` marks as gitlinks.
 *
 * A gitlink is mode `160000` on either side — the mode that says "this entry is a
 * commit of another repository" rather than a blob. Reading the raw diff rather
 * than the whole index keeps this to the change set: `git ls-files --stage` would
 * list every tracked file in the repository, once a second.
 * @param stdout - `-z`-separated raw diff records.
 * @returns the repository-relative paths that are submodules.
 */
export function parseGitlinks(stdout: string): Set<string> {
  const links = new Set<string>()
  const records = stdout.split('\u0000')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === undefined || !record.startsWith(':')) continue
    // `:<oldmode> <newmode> <oldsha> <newsha> <status>`, then the path as its own
    // record; a rename carries two, and either side being a gitlink counts.
    const meta = record.slice(1).split(' ')
    const path = records[index + 1]
    index += 1
    if (path === undefined || path === '') continue
    if (meta[0] === '160000' || meta[1] === '160000') links.add(path)
  }
  return links
}

export function parseNumstat(stdout: string): NumstatEntry[] {
  const tokens = stdout.split('\0')
  const entries: NumstatEntry[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined || token === '') continue
    const firstTab = token.indexOf('\t')
    if (firstTab < 0) continue
    const secondTab = token.indexOf('\t', firstTab + 1)
    if (secondTab < 0) continue
    const rawInsertions = token.slice(0, firstTab)
    const rawDeletions = token.slice(firstTab + 1, secondTab)
    let path = token.slice(secondTab + 1)
    let oldPath: string | undefined
    if (path === '') {
      oldPath = tokens[index + 1]
      path = tokens[index + 2] ?? ''
      index += 2
    }
    if (path === '') continue
    const binary = rawInsertions === '-' || rawDeletions === '-'
    entries.push({
      path,
      oldPath,
      insertions: binary ? null : Number.parseInt(rawInsertions, 10),
      deletions: binary ? null : Number.parseInt(rawDeletions, 10),
      binary,
    })
  }
  return entries
}

/** Runs the resolved git executable under the configured bounds. */
export class GitCommandRunner {
  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly executable: string,
    private readonly limits: GitLimits,
  ) {}

  /**
   * Run one git command to completion.
   * @param args - git arguments; never shell-interpreted.
   * @param options - working directory, cancellation, and an optional output cap.
   * @returns exit facts and collected output.
   * @throws when the command times out, is aborted, or cannot spawn.
   */
  async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
    const timeout = AbortSignal.timeout(this.limits.timeoutMs)
    const signal = AbortSignal.any([options.signal, timeout])
    const handle = this.subprocess.spawn({
      argv: [this.executable, ...args],
      cwd: options.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: options.maxBytes ?? this.limits.outputMaxBytes },
        stderr: { maxBytes: STDERR_TAIL_BYTES },
      },
      graceMs: TERMINATE_GRACE_MS,
      signal,
      env: {
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
      },
    })
    const outcome = await handle.done
    if (signal.aborted) {
      throw new Error(`git ${args.join(' ')} ${timeout.aborted ? `timed out after ${this.limits.timeoutMs}ms` : 'was aborted'}`)
    }
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', nextOffset: 0, lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    return { exitCode: outcome.exitCode, stdout: stdout.text, stderr, truncated: stdout.lossy }
  }
}

/**
 * Reject a failed command with its stderr.
 * @param result - settled command facts.
 * @param what - command description for the error message.
 * @returns the same result when it exited zero.
 */
function ok(result: GitRunResult, what: string): GitRunResult {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim()
    throw new Error(`${what} failed: ${detail === '' ? `exit ${String(result.exitCode)}` : detail}`)
  }
  return result
}

/**
 * Resolve the git executable, refusing the macOS developer-tools stub that
 * would pop an installer dialog instead of running.
 * @param subprocess - the subprocess capability.
 * @param signal - cancellation.
 * @returns the executable path, or null when git is unavailable.
 */
export async function resolveGitExecutable(subprocess: SubprocessRuntime, signal: AbortSignal): Promise<string | null> {
  let executable: string
  try {
    executable = await subprocess.resolveExecutable('git', undefined, signal)
  } catch {
    return null
  }
  if (process.platform !== 'darwin' || executable !== '/usr/bin/git') return executable
  const probe = subprocess.spawn({
    argv: ['/usr/bin/xcode-select', '-p'],
    cwd: process.env['HOME'] ?? '/',
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4_096 }, stderr: { maxBytes: 4_096 } },
    graceMs: 1_000,
    signal,
  })
  const outcome = await probe.done.catch(() => ({ exitCode: null }))
  return outcome.exitCode === 0 ? executable : null
}

/** How one collection run is bounded and scoped. */
export interface CollectOptions {
  /** Absolute Session working directory the counts are scoped to. */
  readonly workspaceRoot: string
  readonly signal: AbortSignal
  /** Maximum changes carried by one snapshot; the totals still report the complete count. */
  readonly maxFiles: number
  /** Largest untracked file read to count its lines. */
  readonly maxUntrackedBytes: number
}

/**
 * Count the lines an untracked file would add.
 * @param file - absolute path.
 * @param maxBytes - inclusive size cap; a larger file is not read.
 * @returns the added line count, or null when the file is binary, too large, or unreadable.
 */
export async function countUntrackedLines(file: string, maxBytes: number): Promise<number | null> {
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch {
    return null
  }
  if (bytes.byteLength > maxBytes) return null
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null
  const text = bytes.toString('utf8')
  if (text === '') return 0
  let lines = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1
  }
  return text.endsWith('\n') ? lines : lines + 1
}

/**
 * Read the change set of the repository enclosing a Session working directory,
 * scoped to that directory.
 * @param git - command runner bound to the resolved executable.
 * @param options - workspace root, cancellation, and the collection caps.
 * @returns the snapshot, or null when the workspace is outside any repository.
 * @throws when a git command fails for any other reason.
 */
export async function collectGitSnapshot(git: GitCommandRunner, options: CollectOptions): Promise<GitSnapshot | null> {
  const { workspaceRoot, signal } = options
  const top = await git.run(['rev-parse', '--show-toplevel'], { cwd: workspaceRoot, signal })
  if (top.exitCode !== 0) {
    if (/not a git repository/i.test(top.stderr)) return null
    throw new Error(`git rev-parse --show-toplevel failed: ${top.stderr.trim() || `exit ${String(top.exitCode)}`}`)
  }
  const repositoryRoot = top.stdout.trim()
  const root = repositoryRoot === '' ? workspaceRoot : repositoryRoot

  // Git translates the workspace into the repository's own spelling. Doing the
  // same job with `path.relative` would break wherever the Session's path is not
  // the canonical one — on macOS `/tmp/ws` against git's `/private/tmp/ws` — and
  // every change would then look like it fell outside the workspace.
  const prefix = ok(await git.run(
    ['rev-parse', '--show-prefix'],
    { cwd: workspaceRoot, signal },
  ), 'git rev-parse --show-prefix').stdout.trim()

  // An unborn branch has no HEAD to diff against; the index and the work tree
  // are read separately and merged per path instead.
  const head = await git.run(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: workspaceRoot, signal })
  const hasHead = head.exitCode === 0

  const status = ok(await git.run(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'],
    { cwd: workspaceRoot, signal },
  ), 'git status')
  const statusEntries = parsePorcelainStatus(status.stdout)

  // The modes come from the same diff, read raw: a gitlink is mode 160000.
  const links = new Set<string>()
  const counts = new Map<string, NumstatEntry>()
  if (hasHead) {
    const diff = ok(await git.run(
      ['diff', '--numstat', '-z', '-M', 'HEAD', '--', '.'],
      { cwd: workspaceRoot, signal },
    ), 'git diff')
    for (const entry of parseNumstat(diff.stdout)) counts.set(entry.path, entry)
    const raw = ok(await git.run(
      ['diff', '--raw', '-z', '-M', 'HEAD', '--', '.'],
      { cwd: workspaceRoot, signal },
    ), 'git diff --raw')
    for (const path of parseGitlinks(raw.stdout)) links.add(path)
  } else {
    const staged = ok(await git.run(
      ['diff', '--numstat', '-z', '-M', '--cached', '--', '.'],
      { cwd: workspaceRoot, signal },
    ), 'git diff --cached')
    const unstaged = ok(await git.run(
      ['diff', '--numstat', '-z', '-M', '--', '.'],
      { cwd: workspaceRoot, signal },
    ), 'git diff')
    const stagedRaw = ok(await git.run(
      ['diff', '--raw', '-z', '-M', '--cached', '--', '.'],
      { cwd: workspaceRoot, signal },
    ), 'git diff --raw --cached')
    const unstagedRaw = ok(await git.run(
      ['diff', '--raw', '-z', '-M', '--', '.'],
      { cwd: workspaceRoot, signal },
    ), 'git diff --raw')
    for (const path of parseGitlinks(stagedRaw.stdout)) links.add(path)
    for (const path of parseGitlinks(unstagedRaw.stdout)) links.add(path)
    const stagedCounts = new Map(parseNumstat(staged.stdout).map(entry => [entry.path, entry]))
    const unstagedCounts = new Map(parseNumstat(unstaged.stdout).map(entry => [entry.path, entry]))
    for (const path of new Set([...stagedCounts.keys(), ...unstagedCounts.keys()])) {
      const entry = stagedCounts.get(path) ?? unstagedCounts.get(path)
      if (entry !== undefined) counts.set(path, entry)
    }
  }

  const collected: GitChange[] = []
  for (const entry of statusEntries) {
    // The pathspec already scoped the listing, so a path outside the prefix can
    // only be a git quirk; drop it rather than report a path the tree cannot key.
    if (!entry.path.startsWith(prefix)) continue
    const path = entry.path.slice(prefix.length)
    if (path === '') continue
    const submodule = links.has(entry.path)
    const numstat = counts.get(entry.path)
    let insertions = numstat?.insertions ?? null
    let deletions = numstat?.deletions ?? null
    let binary = numstat?.binary ?? false
    // Git counts a gitlink as one changed line — the recorded commit itself. That
    // number describes nothing a reader can act on, so a submodule reports none.
    if (submodule) {
      insertions = null
      deletions = null
      binary = false
    } else if (entry.kind === 'untracked' && numstat === undefined) {
      const lines = await countUntrackedLines(join(root, entry.path), options.maxUntrackedBytes)
      if (lines === null) binary = true
      else { insertions = lines; deletions = 0 }
    }
    collected.push({ path, kind: entry.kind, insertions, deletions, binary, submodule })
  }

  collected.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const truncated = collected.length > options.maxFiles
  const changes = truncated ? collected.slice(0, options.maxFiles) : collected

  let insertions = 0
  let deletions = 0
  let binary = 0
  for (const change of collected) {
    insertions += change.insertions ?? 0
    deletions += change.deletions ?? 0
    if (change.binary) binary += 1
  }

  return {
    repositoryRoot: root,
    workspaceRoot,
    changes,
    totals: { files: collected.length, insertions, deletions, binary },
    truncated,
    generatedAt: Date.now(),
  }
}

/** Options for reading one path's unified diff. */
export interface DiffOptions {
  /** Absolute Session working directory the diff is scoped to. */
  readonly workspaceRoot: string
  /** The changed path as the panel spells it: relative to the workspace root. */
  readonly path: string
  readonly signal: AbortSignal
  /** Inclusive cap on the diff text, in UTF-8 bytes. */
  readonly maxBytes: number
}

/** One path's unified diff. */
export interface GitDiff {
  readonly path: string
  readonly diff: string
  readonly truncated: boolean
  readonly untracked: boolean
}

/** The header `git diff` writes for each file, which an untracked read has to be retitled on. */
const DIFF_HEADER = /^diff --git .*$/mu

/**
 * Cut a diff at a line boundary within a byte budget.
 * @param text - the complete diff.
 * @param maxBytes - inclusive cap.
 * @returns the cappable text and whether it was cut.
 */
function capDiff(text: string, maxBytes: number): { text: string, truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
  const boundary = cut.lastIndexOf('\n')
  return { text: boundary === -1 ? cut : cut.slice(0, boundary + 1), truncated: true }
}

/**
 * Read one changed path's unified diff, scoped to the Session workspace.
 *
 * One command answers for both halves of a change: `git diff HEAD` is the work
 * tree against the last commit, so staged and unstaged edits appear together and
 * in file order rather than as two concatenated halves. An unborn branch has no
 * `HEAD` to name, and falls back to the index and work tree read separately.
 *
 * Git cannot diff an untracked path — it has no baseline — so the file is read
 * against `/dev/null` as a whole-file addition. `git add --intent-to-add` would
 * answer with one diff instead, but it writes to the index, and reading a
 * repository must not change it.
 * @param git - command runner bound to the resolved executable.
 * @param options - workspace root, path, cancellation, and the byte cap.
 * @returns the diff, or null when the workspace is outside any repository.
 * @throws when a git command fails for any other reason.
 */
export async function collectGitDiff(git: GitCommandRunner, options: DiffOptions): Promise<GitDiff | null> {
  const { workspaceRoot, path, signal } = options
  const top = await git.run(['rev-parse', '--show-toplevel'], { cwd: workspaceRoot, signal })
  if (top.exitCode !== 0) {
    if (/not a git repository/i.test(top.stderr)) return null
    throw new Error(`git rev-parse --show-toplevel failed: ${top.stderr.trim() || `exit ${String(top.exitCode)}`}`)
  }
  const repositoryRoot = top.stdout.trim()
  const root = repositoryRoot === '' ? workspaceRoot : repositoryRoot
  const prefix = ok(await git.run(
    ['rev-parse', '--show-prefix'],
    { cwd: workspaceRoot, signal },
  ), 'git rev-parse --show-prefix').stdout.trim()
  const target = `${prefix}${path}`

  const status = ok(await git.run(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', target],
    { cwd: root, signal },
  ), 'git status')
  const untracked = parsePorcelainStatus(status.stdout)
    .some(entry => entry.path === target && entry.kind === 'untracked')

  let text: string
  if (untracked) {
    const result = await git.run(
      ['diff', '--no-color', '--no-index', '--unified=3', '--', '/dev/null', target],
      { cwd: root, signal },
    )
    // `--no-index` exits 1 when the two inputs differ, which is the ordinary
    // answer for a file that exists on one side only.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(`git diff --no-index failed: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`)
    }
    text = result.stdout.replace(DIFF_HEADER, `diff --git a/${path} b/${path}`)
  } else {
    const head = await git.run(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, signal })
    if (head.exitCode === 0) {
      text = ok(await git.run(
        ['diff', '--no-color', '--unified=3', 'HEAD', '--', target],
        { cwd: root, signal },
      ), 'git diff HEAD').stdout
    } else {
      const staged = ok(await git.run(
        ['diff', '--no-color', '--unified=3', '--cached', '--', target],
        { cwd: root, signal },
      ), 'git diff --cached').stdout
      const unstaged = ok(await git.run(
        ['diff', '--no-color', '--unified=3', '--', target],
        { cwd: root, signal },
      ), 'git diff').stdout
      text = `${staged}${unstaged}`
    }
  }

  const capped = capDiff(text, options.maxBytes)
  return { path, diff: capped.text, truncated: capped.truncated, untracked }
}


/** One entry read out of a tar archive. */
function tarEntry(archive: Uint8Array, name: string): Uint8Array | undefined {
  const decoder = new TextDecoder()
  let offset = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    // An all-zero block marks the end of the archive.
    if (header.every(byte => byte === 0)) return undefined
    const entryName = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, '')
    const sizeText = decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, '').trim()
    const size = Number.parseInt(sizeText === '' ? '0' : sizeText, 8)
    const body = offset + 512
    // git writes a pax global header before the file it was asked for.
    if (entryName === name || entryName.endsWith(`/${name}`)) return archive.subarray(body, body + size)
    offset = body + Math.ceil(size / 512) * 512
  }
  return undefined
}

/**
 * Read one path's bytes as HEAD records them.
 *
 * A blob has to come back through a **file**, not the subprocess service: that
 * service hands over decoded text, so image bytes would not survive it. `git
 * archive` is the command that both writes to a path of our choosing and reads a
 * committed tree rather than the working tree — `checkout-index --temp` also writes
 * a file, but of the *index*, which is the wrong side of the comparison, and into
 * the working directory. The archive it writes is a tar, so the one entry is read
 * straight out of it.
 * @param git - the runner bound to this Host's git.
 * @param options - the workspace, the repository-relative path, a size cap, and cancellation.
 * @returns the bytes, or null when HEAD holds no such file, or it exceeds the cap.
 */
export async function readGitBlob(
  git: GitCommandRunner,
  options: {
    readonly workspaceRoot: string
    readonly path: string
    readonly maxBytes: number
    readonly signal: AbortSignal
  },
): Promise<Uint8Array | null> {
  const directory = await mkdtemp(join(tmpdir(), 'git-tree-blob-'))
  const archivePath = join(directory, 'head.tar')
  try {
    // The size is asked of git first, so an enormous blob is refused before it is
    // written anywhere. A non-zero exit here is the ordinary answer for a path HEAD
    // does not hold — an added or untracked file — not a failure to report.
    const probe = await git.run(
      ['cat-file', '-s', `HEAD:${options.path}`],
      { cwd: options.workspaceRoot, signal: options.signal },
    )
    if (probe.exitCode !== 0) return null
    const bytes = Number.parseInt(probe.stdout.trim(), 10)
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > options.maxBytes) return null
    ok(await git.run(
      ['archive', '--format=tar', `--output=${archivePath}`, 'HEAD', '--', options.path],
      { cwd: options.workspaceRoot, signal: options.signal },
    ), 'git archive')
    const entry = tarEntry(new Uint8Array(await readFile(archivePath)), options.path)
    return entry === undefined ? null : entry
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}
