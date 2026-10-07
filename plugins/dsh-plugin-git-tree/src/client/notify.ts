/**
 * Telling the push plugin when a Session starts waiting for the reader.
 *
 * This is the one trigger the Host cannot see. Its fold watches the Session log, and
 * "waiting for input" is not in the log — it is an approval or a question raised by
 * the *client* flow, and DSH computes it in a status store only the sidebar reads.
 *
 * The panel already draws that state, one mark per Session, so this watches its own
 * markup. That is a step removed from the source, and it is deliberate: the
 * alternative is a renderless React component holding a subscription to a store this
 * plugin is not allowed to reach. The cost is that the notification only fires while
 * the panel is mounted, which is stated rather than hidden.
 *
 * The call is optional. If the push plugin is not installed the route does not exist
 * and the request fails quietly, which is the whole reason it is fire-and-forget.
 *
 * @module dsh-plugin-git-tree/client/notify
 */

/** The notification text for a Session that has started waiting. */
export interface WaitingNotice {
  readonly sessionId: string
  readonly title?: string
}

/** What the panel draws for one Session. */
export interface StatusRow {
  readonly id: string
  readonly status: string
  readonly title?: string
}

/** The state the previous pass saw, so only a *change* notifies. */
export type StatusMemory = ReadonlyMap<string, string>

/**
 * Sessions that have just started waiting, given what was seen last time.
 *
 * Only a transition counts. A Session that was already waiting must not re-notify on
 * every mutation, or a reader who steps away gets the same message every few seconds.
 * @param previous - the statuses seen last pass.
 * @param rows - the statuses now.
 * @returns the Sessions to tell the reader about.
 */
export function waitingTransitions(previous: StatusMemory, rows: readonly StatusRow[]): WaitingNotice[] {
  const waiting: WaitingNotice[] = []
  for (const row of rows) {
    if (row.status !== 'input') continue
    if (previous.get(row.id) === 'input') continue
    waiting.push({ sessionId: row.id, ...(row.title === undefined || row.title === '' ? {} : { title: row.title }) })
  }
  return waiting
}

/**
 * Remember the statuses just seen.
 * @param rows - the statuses now.
 * @returns the memory for the next pass.
 */
export function rememberStatuses(rows: readonly StatusRow[]): StatusMemory {
  return new Map(rows.map(row => [row.id, row.status]))
}

/** Where the panel's own rows carry their state. */
export const STATUS_SELECTOR = '[data-session-status]'

/**
 * Read the panel's own rows out of the document.
 * @param root - the subtree to read; the document is the fallback.
 * @returns one row per Session the panel is showing.
 */
export function readStatusRows(root: ParentNode): StatusRow[] {
  const rows: StatusRow[] = []
  // A host whose DOM is partial must still get a working panel: reading the marks is
  // an extra, and an extra that throws would take the panel down with it.
  if (typeof root.querySelectorAll !== 'function') return rows
  for (const node of root.querySelectorAll(STATUS_SELECTOR)) {
    const id = node.getAttribute('data-session-id')
    const status = node.getAttribute('data-session-status')
    if (id === null || status === null) continue
    const title = node.getAttribute('data-session-title')
    rows.push({ id, status, ...(title === null ? {} : { title }) })
  }
  return rows
}

/**
 * Report every Session that has started waiting.
 * @param rows - the statuses now.
 * @param previous - the statuses seen last pass.
 * @returns the memory for the next pass.
 */
export function reportWaiting(rows: readonly StatusRow[], previous: StatusMemory): StatusMemory {
  for (const notice of waitingTransitions(previous, rows)) {
    const body = JSON.stringify({
      sessionId: notice.sessionId,
      trigger: 'needs-input',
      ...(notice.title === undefined ? {} : { title: notice.title }),
      detail: 'waiting for you',
    })
    // Fire and forget: a reader who is away is exactly who this is for, and a failed
    // notification must never break the panel that noticed.
    void fetch('api/push/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }).catch(() => {})
  }
  return rememberStatuses(rows)
}

/**
 * Watch the panel for Sessions that start waiting.
 * @param root - the subtree to watch; the document is the fallback.
 * @returns a function that stops watching.
 */
export function installWaitingReporter(root?: ParentNode): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const scope: ParentNode = root ?? document.body
  let memory: StatusMemory = rememberStatuses(readStatusRows(scope))
  const observer = new MutationObserver(() => {
    memory = reportWaiting(readStatusRows(scope), memory)
  })
  observer.observe(scope as Node, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-session-status'] })
  return () => { observer.disconnect() }
}
