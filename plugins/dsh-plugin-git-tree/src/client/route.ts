/**
 * Reading one JSON route, and saying what went wrong when it is not JSON.
 *
 * A route that is not registered, one behind a proxy, and one answered by a
 * Host half older than the browser half all reply with something that is not the
 * JSON a caller expects. `response.json()` then throws a syntax error naming the
 * text it choked on, which is the symptom and never the cause — the operator sees
 * `Unexpected token 'o', "not found" is not valid JSON` and learns nothing about
 * which route, or why it was missing.
 */

/** How much of an unexpected body to quote back. */
const SNIPPET_CHARS = 120

/** One route read: the parsed body, or why there was none to parse. */
export type JsonRouteRead =
  | { readonly ok: true, readonly body: unknown }
  | { readonly ok: false, readonly code: string, readonly message: string }

/** The first line of a body, trimmed and clipped, for a diagnostic. */
function snippet(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return '(an empty body)'
  const firstLine = trimmed.split('\n', 1)[0] ?? trimmed
  return firstLine.length > SNIPPET_CHARS ? `${firstLine.slice(0, SNIPPET_CHARS)}…` : firstLine
}

/**
 * Parse one route response, naming the route's answer when it is not JSON.
 *
 * The 404 case is called out because it has one overwhelmingly likely cause: the
 * Host half of a plugin is mounted once at boot, so a route added since the server
 * started is simply not registered, while the browser half — served per load —
 * already knows about it. Saying "restart" beats saying "unexpected token".
 * @param what - the route's name, as copy should call it.
 * @param response - the settled response.
 * @returns the parsed body, or a failure naming what came back instead.
 */
export async function readJsonRoute(what: string, response: Response): Promise<JsonRouteRead> {
  const text = await response.text()
  let body: unknown
  try {
    // An empty body is not JSON either, and no route here answers one on purpose,
    // so it goes down the same path as any other unparseable answer.
    body = JSON.parse(text) as unknown
  } catch {
    if (response.status === 404) {
      return {
        ok: false,
        code: 'route-missing',
        message: `${what} is not registered on this Host (404: ${snippet(text)}). A plugin's Host half mounts once at boot, so restarting dsh web is what registers a route added since it started.`,
      }
    }
    return {
      ok: false,
      code: 'not-json',
      message: `${what} answered ${String(response.status)} with ${snippet(text)}`,
    }
  }
  return { ok: true, body }
}
