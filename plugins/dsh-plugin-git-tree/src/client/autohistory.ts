/**
 * Asking for older history when the reader reaches the head of the transcript.
 *
 * The chat renders a "Load earlier" control over the head of the history and pages
 * through that click alone: nothing in it is scroll-driven, there is no setting for
 * it, and no service reaches the view's scroll controller. So this presses the
 * control the way a reader does — on the scroll of the port that holds it, once the
 * reader is within a page-worth of the top.
 *
 * The control is found by its CSS-module local name, the same way this bundle
 * hides the shell's New Session button, and the scrollport is whichever ancestor
 * actually scrolls: the transcript root clips rather than scrolls, so the element
 * that fires the event is not the one the control sits in. A missing control means
 * there is no more history to ask for, and the press is skipped while one is
 * already in flight — the chat disables the control for exactly that window, and
 * its own loader refuses a second page regardless.
 */
/** How close to the head, in CSS pixels, a page is asked for. */
export const EARLIER_TRIGGER_PX = 320

/**
 * Whether a scroll offset is close enough to the head to ask for older history.
 * @param scrollTop - the scrollport's offset from its top edge.
 * @param threshold - the distance, in CSS pixels, at which a page is asked for.
 * @returns true when a page should be asked for.
 */
export function wantsEarlierPage(
  scrollTop: number,
  threshold: number = EARLIER_TRIGGER_PX,
): boolean {
  return scrollTop <= threshold
}

/** The slice of a scrollport and its control this needs, so it can be driven in a test. */
interface ScrolledPort {
  readonly scrollTop: number
  querySelector(selector: string): unknown
}

/** The slice of an element this needs. */
interface Pressable {
  readonly disabled?: boolean
  click(): void
}

/** The slice of a document this needs. */
export interface DocumentLike {
  addEventListener(type: string, listener: (event: Event) => void, options: AddEventListenerOptions): void
  removeEventListener(type: string, listener: (event: Event) => void, options: AddEventListenerOptions): void
}

/** Narrow an event target to something with a scroll offset and a query. */
function asPort(target: unknown): ScrolledPort | undefined {
  if (target === null || typeof target !== 'object') return undefined
  const port = target as Partial<ScrolledPort>
  if (typeof port.scrollTop !== 'number' || typeof port.querySelector !== 'function') return undefined
  return port as ScrolledPort
}

/** Narrow a node to something that can be pressed. */
function asPressable(node: unknown): Pressable | undefined {
  if (node === null || typeof node !== 'object') return undefined
  const pressable = node as Partial<Pressable>
  if (typeof pressable.click !== 'function') return undefined
  return pressable as Pressable
}

/** The options a scroll listener is registered with: captured, because scroll does not bubble. */
const CAPTURE: AddEventListenerOptions = { capture: true, passive: true }

/**
 * Press the transcript's older-history control whenever the reader nears the head.
 *
 * One listener on the document in the capture phase rather than per-port
 * bookkeeping: the port is whichever element scrolls, it can be replaced without
 * notice, and `scroll` does not bubble — so the document sees every port and the
 * event's own target says which one moved.
 * @param target - the document to listen on.
 * @returns a disposer that removes the listener.
 */
export function installAutoHistory(target: DocumentLike): () => void {
  const onScroll = (event: Event): void => {
    const port = asPort(event.target)
    if (port === undefined || !wantsEarlierPage(port.scrollTop)) return
    const wrapper = port.querySelector("[class*='_older']")
    if (wrapper === null || wrapper === undefined || typeof wrapper !== 'object') return
    const button = asPressable((wrapper as { querySelector?: (selector: string) => unknown }).querySelector?.('button'))
    if (button === undefined || button.disabled === true) return
    button.click()
  }
  target.addEventListener('scroll', onScroll, CAPTURE)
  return () => { target.removeEventListener('scroll', onScroll, CAPTURE) }
}
