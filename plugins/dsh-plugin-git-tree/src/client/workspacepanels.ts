/**
 * Per-workspace right-Sidebar panels.
 *
 * The kit keys a right-panel layout by **Session**: two Sessions of one Workspace
 * get two independent tab sets, and moving between them shelves and restores
 * nothing. A Workspace is the unit a reader thinks in, so the panel is made to
 * behave that way here.
 *
 * The seam that makes it possible is the controller's open-tab inventory — a
 * read-only observable it already shares with content providers. It reports every
 * open tab of every adopted Session, so this module never has to close a tab to
 * learn what is open, and nothing here is destructive.
 *
 * The rules, in the order they are applied on every change:
 *
 * 1. Entering a Session whose Workspace has a remembered set opens whatever that
 *    set holds and the Session does not.
 * 2. Otherwise the foreground Session's own tabs *become* its Workspace's set.
 *
 * The skip on the entering tick is what keeps rule 2 from erasing the memory: a
 * Session is empty at the instant it becomes foreground, and recording it then
 * would replace the set with nothing. The opens rule 1 issues arrive as inventory
 * changes, and the sync that follows them records the settled set.
 *
 * A Session belongs to exactly one Workspace, so a Session's tabs can never mix
 * two Workspaces — which is why entering only ever needs to add, never to remove.
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** One open tab, as far as this module cares. */
export interface PanelTab {
  /** The tab type's kind; kept so a non-address tab can be recognised and dropped. */
  readonly kind: string
  /** The address a resource tab was opened at; also the tab record's `contentId`. */
  readonly contentId: string
  /** The tab's own id, when the inventory gave one, so an extra tab can be closed. */
  readonly tabId?: string
}

/** One inventory entry, structurally: the package does not re-export the interface. */
export interface OpenTabLike {
  readonly sessionId: string
  readonly tabId?: string
  readonly kind: string
  readonly contentId: string
}

/** The address prefix every restorable tab is opened at. */
const RESOURCE_PREFIX = 'dsh-resource://'

/**
 * The tabs one Session holds, in inventory order.
 * @param entries - the whole inventory.
 * @param sessionId - the Session to read.
 * @returns that Session's tabs.
 */
export function sessionTabs(entries: readonly OpenTabLike[], sessionId: string): PanelTab[] {
  const tabs: PanelTab[] = []
  for (const entry of entries) {
    if (entry.sessionId !== sessionId) continue
    tabs.push({ kind: entry.kind, contentId: entry.contentId, tabId: entry.tabId })
  }
  return tabs
}

/**
 * The address to re-open a remembered tab at.
 *
 * Only resource addresses can be re-opened by a bundle that does not own the tab
 * type: `openResource` claims an address through the tab registry, which every
 * address-backed type takes part in. A page opened by kind would need that kind's
 * own navigation parameters, which are not part of a tab record, so it is dropped
 * rather than reopened wrong.
 * @param tab - one remembered tab.
 * @returns the address, or undefined when the tab is not address-backed.
 */
export function restorableAddress(tab: PanelTab): string | undefined {
  return tab.contentId.startsWith(RESOURCE_PREFIX) ? tab.contentId : undefined
}

/**
 * The remembered tabs a Session does not already hold.
 * @param desired - the Workspace's remembered set, in order.
 * @param open - the Session's own tabs.
 * @returns the entries to open, in the order they were remembered.
 */
export function missingTabs(
  desired: readonly PanelTab[],
  open: readonly PanelTab[],
  sessionId?: string,
): PanelTab[] {
  // Compared against the address the Session being entered would actually open, not
  // the one the set remembers: those differ by the Session id they carry.
  const held = new Set(
    open.map(tab => (sessionId === undefined ? tab.contentId : retargetAddress(tab.contentId, sessionId))),
  )
  const restoring = new Set<string>()
  const missing: PanelTab[] = []
  for (const tab of desired) {
    const address = restorableAddress(tab)
    if (address === undefined) continue
    const target = sessionId === undefined ? address : retargetAddress(address, sessionId)
    if (held.has(target)) continue
    // A set that remembered the same address twice opens it once.
    if (restoring.has(target)) continue
    restoring.add(target)
    // Only what opening needs: the address now points at the Session being entered.
    missing.push({ kind: tab.kind, contentId: target })
  }
  return missing
}

/**
 * Which Workspace a Session belongs to.
 * @param items - the Workspace snapshot's list.
 * @param sessionId - the Session to place.
 * @returns the Workspace id, or undefined when no Workspace accounts for it.
 */
export function workspaceOfSession(
  items: readonly { readonly workspaceId: string, readonly sessionIds: readonly string[] }[],
  sessionId: string,
): string | undefined {
  for (const item of items) {
    if (item.sessionIds.includes(sessionId)) return item.workspaceId
  }
  return undefined
}

/** What each Workspace had open, remembered for as long as the plugin lives. */
export class WorkspacePanels {
  private readonly remembered = new Map<string, readonly PanelTab[]>()

  /**
   * The set remembered for one Workspace.
   * @param workspaceId - the Workspace to read.
   * @returns its set, empty when nothing has been recorded.
   */
  tabs(workspaceId: string): readonly PanelTab[] {
    return this.remembered.get(workspaceId) ?? []
  }

  /**
   * Replace one Workspace's set.
   * @param workspaceId - the Workspace to record.
   * @param tabs - the set it now holds.
   */
  record(workspaceId: string, tabs: readonly PanelTab[]): void {
    this.remembered.set(workspaceId, tabs)
  }
}

/** The inventory observable, which the controller class carries without declaring. */
export type OpenTabsSource = ObservableSnapshot<readonly OpenTabLike[]>

/**
 * The same address, pointed at another Session of the same Workspace.
 *
 * A resource address is **Session-scoped**: `dsh-resource://<protocol>/session/<id>/<path>`,
 * with the path relative to that Session's workspace. So the tabs one Session had are
 * not the tabs another Session can open — replaying them verbatim opens resources
 * belonging to the Session they came from. Since a Workspace's Sessions share a
 * workspace root, the path is what carries over, and the Session id is what has to be
 * replaced.
 *
 * This is why the shelf is keyed by Workspace at all: the tabs are the Workspace's,
 * and each Session gets its own addresses for them.
 * @param address - a remembered address.
 * @param sessionId - the Session to point it at.
 * @returns the retargeted address, or the original when it is not a session address.
 */
export function retargetAddress(address: string, sessionId: string): string {
  return address.replace(/^(dsh-resource:\/\/[^/]+\/session\/)[^/]+(\/)/, `$1${sessionId}$2`)
}

/**
 * The tabs a Session holds that its Workspace's set no longer does.
 *
 * Entering has to *match*, not merely add: a Session that kept a copy of a tab the
 * reader has since closed elsewhere would otherwise hand that copy back to the set
 * the next time it is recorded, and the tab would come back from the dead on every
 * switch.
 * @param desired - the Workspace's remembered set.
 * @param open - the Session's own tabs.
 * @param sessionId - the Session being entered, whose addresses the set is read as.
 * @returns the tabs to close.
 */
export function extraTabs(
  desired: readonly PanelTab[],
  open: readonly PanelTab[],
  sessionId: string,
): PanelTab[] {
  const wanted = new Set(
    desired
      .map(tab => restorableAddress(tab))
      .filter((address): address is string => address !== undefined)
      .map(address => retargetAddress(address, sessionId)),
  )
  return open.filter(tab => tab.tabId !== undefined && !wanted.has(tab.contentId))
}
