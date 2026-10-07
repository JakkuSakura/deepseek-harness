/**
 * Opening the process rows a reader would otherwise have to open one by one.
 *
 * The work-details `verbose` mode un-folds a completed Turn and lists its process
 * rows directly — that much is a setting, and it is set. What it does *not* do is
 * open the rows themselves: each keeps its own disclosure, `useDisclosure` starts
 * collapsed, and it takes no policy input, so no mode and no setting opens them.
 * This bundle opens each one as it appears.
 *
 * A row is a `<div data-expandable aria-expanded="false">`, not a native
 * `<details>`, so it is opened the way a reader opens it — by clicking, which is
 * what React listens for — and the rows are scoped to the transcript's own flow
 * column so nothing outside the conversation is touched.
 *
 * A row that React re-collapses is opened **again**. The first version opened each row
 * once and remembered it by key, which failed in exactly the case that matters: a row
 * still streaming re-renders constantly, its disclosure state is reset by the remount,
 * and the memory refused to re-open it — so a running command stayed shut and only
 * unfolded after it had finished, when there was nothing left to watch.
 *
 * What must not be undone is the **reader's** collapse, so that is what is remembered:
 * a click that is not ours records their intent for that row, and a row they closed is
 * left closed. Rows are opened only when nothing says otherwise.
 */

/** A closed process row: expandable, and reporting itself collapsed. */
const CLOSED_ROW = '[data-expandable][aria-expanded="false"]'

/** Any row that can be opened, closed or not. */
const ROW = '[data-expandable]'

/** The transcript's flow column. Nothing outside it is touched. */
const FLOW = '[data-chat-flow]'

/** The ancestors that name a row: a tool call, or a node and its group part. */
const KEYED = '[data-chat-call-id], [data-chat-node-key]'

/** How often a batch of transcript changes is allowed to trigger one pass. */
const PASS_DELAY_MS = 150

/** The slice of a keyed ancestor this needs. */
interface KeyedElement {
  getAttribute(name: string): string | null
}

/** The slice of a process row this needs. */
export interface ExpandableRow {
  click(): void
  closest(selector: string): KeyedElement | null
}

/** The slice of the transcript's flow column this needs. */
interface FlowElement {
  querySelectorAll(selector: string): ArrayLike<ExpandableRow>
}

/** The slice of a document this needs. */
export interface ExpandableDocument {
  readonly body: object
  querySelectorAll(selector: string): ArrayLike<unknown>
  /** Optional, so a test double without events still drives the pass. */
  addEventListener?(type: string, listener: (event: unknown) => void, capture?: boolean): void
  removeEventListener?(type: string, listener: (event: unknown) => void, capture?: boolean): void
}

/** The slice of a click this needs. */
interface ClickLike {
  readonly target?: unknown
}

/** The slice of a MutationObserver this needs. */
export interface RowObserver {
  observe(target: object, options: MutationObserverInit): void
  disconnect(): void
}

/**
 * The name a row is remembered under.
 *
 * A tool call has its own id; anything else is named by its node key and which
 * part of the step it is, which is what its ancestors carry. A row with neither is
 * left alone rather than opened under a name several rows would share.
 * @param row - one closed process row.
 * @returns the key, or null when the row carries no identity.
 */
export function rowKey(row: ExpandableRow): string | null {
  const keyed = row.closest(KEYED)
  if (keyed === null) return null
  const call = keyed.getAttribute('data-chat-call-id')
  if (call !== null && call !== '') return call
  const node = keyed.getAttribute('data-chat-node-key')
  if (node === null || node === '') return null
  return `${node}:${keyed.getAttribute('data-chat-group-part') ?? ''}`
}

/**
 * Open every closed row that has not been opened before.
 * @param rows - the closed rows found in one pass.
 * @param opened - the keys already opened, extended in place.
 * @returns how many rows this pass opened.
 */
export function expandClosedRows(
  rows: ArrayLike<ExpandableRow>,
  refused: ReadonlySet<string>,
  mine?: WeakSet<ExpandableRow>,
): number {
  let count = 0
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row === undefined) continue
    const key = rowKey(row)
    // No identity, or the reader closed this one: leave it exactly as it is.
    if (key === null || refused.has(key)) continue
    mine?.add(row)
    row.click()
    count += 1
  }
  return count
}

/**
 * Open the transcript's closed process rows as they appear.
 * @param target - the document to watch.
 * @param createObserver - how to observe; injected so this can be driven in a test.
 * @returns a disposer that stops watching and disconnects the observer.
 */
export function installExpandProcessRows(
  target: ExpandableDocument,
  createObserver: (callback: () => void) => RowObserver = callback => new MutationObserver(callback),
): () => void {
  /** Rows the reader closed themselves; their intent outranks ours. */
  const refused = new Set<string>()
  /** The rows this code clicked, so its own events are not mistaken for the reader's. */
  const mine = new WeakSet<ExpandableRow>()
  let scheduled = false
  const pass = (): void => {
    scheduled = false
    const flows = target.querySelectorAll(FLOW) as unknown as ArrayLike<FlowElement>
    for (let index = 0; index < flows.length; index += 1) {
      const flow = flows[index]
      if (flow === undefined) continue
      expandClosedRows(flow.querySelectorAll(CLOSED_ROW), refused, mine)
    }
  }
  // Streaming mutates the transcript constantly, so passes are coalesced: one runs
  // a moment after the last change rather than once per text node.
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    setTimeout(pass, PASS_DELAY_MS)
  }
  // A click on a row is the reader deciding, and it is read *before* React toggles the
  // attribute: still closed means they are opening it, already open means they are
  // shutting it. Clicks this code made are ignored, or the auto-open would cancel itself.
  const onCapture = (event: unknown): void => {
    const node = (event as ClickLike | null)?.target
    if (typeof node !== 'object' || node === null) return
    const closest = (node as { closest?: (selector: string) => unknown }).closest
    if (typeof closest !== 'function') return
    const row = closest.call(node, ROW) as ExpandableRow | null
    if (row === null || mine.has(row)) return
    const key = rowKey(row)
    if (key === null) return
    const expanded = (row as { getAttribute?: (name: string) => string | null }).getAttribute?.('aria-expanded')
    if (expanded === 'false') refused.delete(key)
    else refused.add(key)
  }
  target.addEventListener?.('click', onCapture, true)

  const observer = createObserver(schedule)
  observer.observe(target.body, { childList: true, subtree: true })
  pass()
  return () => {
    observer.disconnect()
    target.removeEventListener?.('click', onCapture, true)
  }
}
