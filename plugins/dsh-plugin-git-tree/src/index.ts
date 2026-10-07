/**
 * Host half of the git-tree plugin.
 *
 * It owns one authenticated JSON route on the shared API channel and nothing
 * else: the workspace file listing the browser draws comes from the existing
 * `workspaceFiles` Remote namespace, so only the git counts need a Host
 * endpoint. The route resolves the Session's working directory from its
 * identity rather than trusting a path from the browser.
 *
 * `inject` names Cordis *services*, so the fiber waits until the API channel,
 * the Session store, and the subprocess capability are all available.
 */
import { basename, dirname, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import { GitCommandRunner, collectGitDiff, collectGitSnapshot, readGitBlob, resolveGitExecutable } from './host/git.ts'
import type { GitBlobResponse, GitDiffResponse, GitStatsResponse } from './wire.ts'

/** Plugin name reported in Loader diagnostics. */
export const name = 'git-tree'

/** Required Host services: the shared API channel, live Sessions, and process spawning. */
export const inject = ['connection', 'sessions', 'subprocess']

/**
 * Absolute registration path. The browser addresses it in document-relative
 * form (`api/git-tree`) because the Web shell injects `<base href="./">`.
 */
export const GIT_TREE_ROUTE = '/api/git-tree'

/** One path's diff, under the same authenticated channel and prefix. */
export const GIT_DIFF_ROUTE = '/api/git-tree/diff'

/** The committed-bytes endpoint, for paths a diff can only call binary. */
export const GIT_BLOB_ROUTE = '/api/git-tree/blob'

/** Largest committed blob this plugin will hand back, in bytes. */
const MAX_BLOB_BYTES = 2 * 1024 * 1024

/**
 * Media type for a path, from its extension.
 *
 * Only the formats a diff can never show as text are worth naming; everything else
 * answers as an opaque download, which is what a browser does with it anyway.
 * @param path - the repository-relative path.
 * @returns the media type.
 */
function mimeOfPath(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const known: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
  }
  return known[extension] ?? 'application/octet-stream'
}

/**
 * Answer one `/api/git-tree/blob` request.
 *
 * Under the same fence as the other two routes: the workspace, its repository and
 * the file's location all come from the live Session header, and the path is
 * resolved against the workspace root and refused when it leaves it. The bytes
 * come back as base64 inside the same JSON envelope, so a failure reads the same
 * way everywhere rather than as an opaque non-200.
 * @param ctx - Host context carrying the Session store and subprocess capability.
 * @param request - the admitted Fetch request.
 * @returns the JSON response carrying the bytes, or why there are none.
 */
async function handleGitBlob(ctx: Context, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const rawSessionId = url.searchParams.get('sessionId')
  const path = url.searchParams.get('path')
  if (rawSessionId === null || rawSessionId === '' || path === null || path === '') {
    return sendJson(400, { status: 'error', code: 'bad-request', message: 'sessionId and path are required' })
  }
  const session = ctx.sessions.get(rawSessionId as SessionId)
  const workspaceRoot = session?.header.cwd
  if (workspaceRoot === undefined) {
    return sendJson(404, {
      status: 'error',
      code: 'no-session',
      message: `no live session ${rawSessionId} with a working directory`,
    })
  }
  const base = resolve(workspaceRoot)
  const absolute = resolve(base, path)
  if (absolute !== base && !absolute.startsWith(`${base}${sep}`)) {
    return sendJson(400, { status: 'error', code: 'bad-request', message: 'path must be inside the workspace' })
  }

  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(GIT_LIMITS.timeoutMs)])
  let executable: string | null
  try {
    executable = await resolveGitExecutable(ctx.subprocess, signal)
  } catch {
    executable = null
  }
  if (executable === null) {
    return sendJson(200, { status: 'error', code: 'git-unavailable', message: 'git is not available on this Host' })
  }

  try {
    const git = new GitCommandRunner(ctx.subprocess, executable, GIT_LIMITS)
    const bytes = await readGitBlob(git, { workspaceRoot, path, maxBytes: MAX_BLOB_BYTES, signal })
    if (bytes === null) {
      // Either HEAD holds no such file — an added or untracked path — or it is
      // larger than this route will carry. Both say the same thing to a reader:
      // there is no earlier version to put beside this one.
      return sendJson(200, {
        status: 'error',
        code: 'no-previous',
        message: 'HEAD holds no such file, or it is too large to carry',
      })
    }
    return sendJson(200, { status: 'ok', base64: Buffer.from(bytes).toString('base64'), mime: mimeOfPath(path) })
  } catch (error: unknown) {
    if (signal.aborted) {
      return sendJson(200, { status: 'error', code: 'aborted', message: 'the git read was aborted' })
    }
    return sendJson(200, {
      status: 'error',
      code: 'git-failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Bounds every git command the endpoint runs. */
const GIT_LIMITS = { timeoutMs: 30_000, outputMaxBytes: 4 * 1024 * 1024 }
/** Changes one response may carry; the totals still report the complete count. */
const MAX_FILES = 2_000
/** Largest untracked file read to count its lines. */
const MAX_UNTRACKED_BYTES = 512 * 1024
/** Largest diff text one response may carry; a longer one is cut at a line boundary. */
const MAX_DIFF_BYTES = 512 * 1024

/** JSON response with no caching: the working tree is live state. */
function sendJson(
  res: ResponseInit['status'],
  body: GitStatsResponse | GitDiffResponse | GitBlobResponse,
): Response {
  return Response.json(body, {
    status: res,
    headers: { 'cache-control': 'no-store' },
  })
}

/**
 * Answer one `/api/git-tree` request.
 *
 * The only input is `sessionId`; the workspace root is read from the live
 * Session header, so a browser cannot ask for counts outside a Session it can
 * already see. `github`-style path parameters are deliberately not accepted.
 * @param ctx - Host context carrying the Session store and subprocess capability.
 * @param request - the admitted Fetch request.
 * @returns the JSON response.
 */
async function handleGitTree(ctx: Context, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const rawSessionId = url.searchParams.get('sessionId')
  if (rawSessionId === null || rawSessionId === '') {
    return sendJson(400, { status: 'error', code: 'bad-request', message: 'sessionId is required' })
  }
  const session = ctx.sessions.get(rawSessionId as SessionId)
  const workspaceRoot = session?.header.cwd
  if (workspaceRoot === undefined) {
    return sendJson(404, {
      status: 'error',
      code: 'no-session',
      message: `no live session ${rawSessionId} with a working directory`,
    })
  }

  // A submodule is read by naming it: the snapshot is scoped to that directory, so
  // the same collector answers for a directory inside the workspace that is itself
  // a repository. The path is resolved against the workspace and fenced to it — a
  // reader may ask about a submodule, never about a directory outside the Session.
  const submodule = url.searchParams.get('submodule')
  let scopedRoot = workspaceRoot
  if (submodule !== null && submodule !== '') {
    const base = resolve(workspaceRoot)
    const candidate = resolve(base, submodule)
    if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) {
      return sendJson(400, {
        status: 'error',
        code: 'bad-request',
        message: 'submodule must be a directory inside the workspace',
      })
    }
    scopedRoot = candidate
  }

  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(GIT_LIMITS.timeoutMs)])
  let executable: string | null
  try {
    executable = await resolveGitExecutable(ctx.subprocess, signal)
  } catch {
    executable = null
  }
  if (executable === null) {
    return sendJson(200, {
      status: 'error',
      code: 'git-unavailable',
      message: 'git is not available on this Host',
    })
  }

  try {
    const git = new GitCommandRunner(ctx.subprocess, executable, GIT_LIMITS)
    const snapshot = await collectGitSnapshot(git, {
      workspaceRoot: scopedRoot,
      signal,
      maxFiles: MAX_FILES,
      maxUntrackedBytes: MAX_UNTRACKED_BYTES,
    })
    if (snapshot === null) return sendJson(200, { status: 'no-repository' })
    return sendJson(200, { status: 'ok', snapshot })
  } catch (error: unknown) {
    if (signal.aborted) {
      return sendJson(200, { status: 'error', code: 'aborted', message: 'the git read was aborted' })
    }
    return sendJson(200, {
      status: 'error',
      code: 'git-failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Answer one `/api/git-tree/diff` request.
 *
 * The inputs are the Session and the path *within* that Session's workspace; the
 * repository, its root, and the file's absolute location are all resolved from
 * the live Session header, so a browser cannot ask for the diff of a path it
 * could not already read through the workspace-files Remote.
 * @param ctx - Host context carrying the Session store and subprocess capability.
 * @param request - the admitted Fetch request.
 * @returns the JSON response.
 */
async function handleGitDiff(ctx: Context, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const rawSessionId = url.searchParams.get('sessionId')
  const path = url.searchParams.get('path')
  if (rawSessionId === null || rawSessionId === '' || path === null) {
    return sendJson(400, {
      status: 'error',
      code: 'bad-request',
      message: 'sessionId and path are required',
    })
  }
  const session = ctx.sessions.get(rawSessionId as SessionId)
  const workspaceRoot = session?.header.cwd
  if (workspaceRoot === undefined) {
    return sendJson(404, {
      status: 'error',
      code: 'no-session',
      message: `no live session ${rawSessionId} with a working directory`,
    })
  }

  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(GIT_LIMITS.timeoutMs)])
  let executable: string | null
  try {
    executable = await resolveGitExecutable(ctx.subprocess, signal)
  } catch {
    executable = null
  }
  if (executable === null) {
    return sendJson(200, {
      status: 'error',
      code: 'git-unavailable',
      message: 'git is not available on this Host',
    })
  }

  // Ask the repository that actually holds the file, not the Session's. For a path
  // inside a submodule those differ, and the workspace's repository sees only a
  // gitlink - it would call the file untracked. The file's own directory is where
  // to ask, because git walks up from there to the innermost repository; the
  // workspace root is the fallback for a path whose directory is gone, which is how
  // a file deleted along with its directory still reports its deletion.
  const base = resolve(workspaceRoot)
  const absolute = resolve(base, path)
  if (absolute !== base && !absolute.startsWith(base + sep)) {
    return sendJson(400, { status: 'error', code: 'bad-request', message: 'path must be inside the workspace' })
  }

  try {
    const git = new GitCommandRunner(ctx.subprocess, executable, GIT_LIMITS)
    const directory = dirname(absolute)
    // Whether git can even be entered from there decides which repository answers.
    // A missing directory throws rather than exits non-zero, which is the ordinary
    // case for a file deleted along with the directory that held it.
    // Asked with `-C` from the workspace rather than by running *in* the directory:
    // a process spawned with a cwd that no longer exists fails at the process level,
    // where no caller can catch it. Git reports a missing `-C` directory as an
    // ordinary non-zero exit instead.
    const enterable = await git.run(['-C', directory, 'rev-parse', '--show-prefix'], {
      cwd: workspaceRoot,
      signal,
    })
    const inside = enterable.exitCode === 0
    const found = await collectGitDiff(git, {
      workspaceRoot: inside ? directory : workspaceRoot,
      path: inside ? basename(absolute) : path,
      signal,
      maxBytes: MAX_DIFF_BYTES,
    })
    if (found === null) return sendJson(200, { status: 'no-repository' })
    // The read happened inside whichever repository holds the file, but the reader
    // asked about a path in the Session's workspace — so that is the path reported.
    const view = inside ? { ...found, path } : found
    return sendJson(200, { status: 'ok', view })
  } catch (error: unknown) {
    if (signal.aborted) {
      return sendJson(200, { status: 'error', code: 'aborted', message: 'the git read was aborted' })
    }
    return sendJson(200, {
      status: 'error',
      code: 'git-failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Register the git counts endpoint.
 * @param ctx - Host context; the fiber waits for the injected services.
 */
export function apply(ctx: Context): void {
  void ctx.connection.fetch.register({
    path: GIT_TREE_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => handleGitTree(ctx, request),
  })
  void ctx.connection.fetch.register({
    path: GIT_BLOB_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => handleGitBlob(ctx, request),
  })
  ctx.connection.fetch.register({
    path: GIT_DIFF_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => handleGitDiff(ctx, request),
  })
}
