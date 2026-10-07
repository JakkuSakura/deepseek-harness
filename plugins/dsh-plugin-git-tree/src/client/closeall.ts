/**
 * Closing every tab the right Sidebar can close.
 *
 * The controller publishes operations and no inventory. Nothing lists the open
 * tabs: `active()` reads one, and the per-session layout store behind it is handed
 * straight into the controller rather than published, so no `ctx.provide` carries
 * it either. What the face does publish is enough to walk the column the way a
 * person does — close the tab in front of you, and the kit focuses a survivor.
 *
 * There is no batch close, so this is the repeated-close path and inherits its
 * shape:
 *
 * - A close is not necessarily settled when the call returns. A tab kind may
 *   retain asynchronous cleanup before its record is removed, so the same tab can
 *   still be active on the next read. Each step therefore waits out a short settle
 *   window rather than assuming the surface has already moved.
 * - A tab that refuses to go leaves itself active. The kit's guide is that tab: it
 *   is the default page, it draws no close control, and a programmatic close of it
 *   records nothing. Reading it a second time ends the walk instead of spinning.
 * - The walk is capped, so a kind that keeps a tab alive by failing its own close
 *   handler cannot hold the loop open.
 */
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** How long one close is given to settle before the next tab is read. */
const SETTLE_MS = 40
/** Most tabs one walk will close, so a surface that never changes cannot spin. */
const MAX_STEPS = 64

/** Wait out one close. */
function settle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, SETTLE_MS) })
}

/**
 * Close every tab of the mounted right Sidebar that will close.
 *
 * The guide, which cannot close, is left standing as the column's default page —
 * which is the state the kit itself reaches by closing the last remaining tab.
 * @param surface - the right-Sidebar controller, or the slice of it this needs.
 * @returns the tab ids the walk attempted, in order; a guard reads this.
 */
export async function closeEveryTab(
  surface: Pick<ISidebarRight, 'active' | 'close'>,
): Promise<readonly string[]> {
  const attempted: string[] = []
  const seen = new Set<string>()
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const tab = surface.active()
    if (tab === undefined) break
    const id = String(tab.id)
    // A tab still standing after its own close is one that refused: stop here.
    if (seen.has(id)) break
    seen.add(id)
    attempted.push(id)
    surface.close(tab.id)
    await settle()
  }
  return attempted
}
