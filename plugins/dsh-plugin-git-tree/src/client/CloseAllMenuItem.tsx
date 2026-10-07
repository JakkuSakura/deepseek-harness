/**
 * The tab menu's "Close all tabs" entry.
 *
 * Registered at `sidebar.right.tab.menu.item`, which the kit describes as extra
 * items at the end of one tab's actions menu, with entries deciding their own
 * visibility from the tab they are given. That seat's stated tenant is an action
 * "that means something about the tab's content", and closing every tab is not
 * that — it is a layout gesture, which the kit keeps for itself. The controller
 * publishes no inventory and no batch close, so this seat is the only place a
 * bundle from outside the product can offer the action at all; the entry is
 * written to say plainly what it does rather than to pretend to be content.
 */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './locales.ts'

/** The composed props of one `sidebar.right.tab.menu.item` entry in this namespace. */
export type CloseAllMenuItemProps =
  & PropsRuntime<'sidebar.right.tab.menu.item'>
  & PropsLocale<'gitTree'>
  & {
    /**
     * Close every tab the column can close.
     * @returns completion once the walk has settled.
     */
    readonly closeAllTabs: () => Promise<void>
  }

/**
 * Draw the entry.
 * @param props - the open tab, the menu's dismiss, the walk, and copy.
 * @returns the menu row.
 */
export function CloseAllMenuItem(props: CloseAllMenuItemProps): ReactNode {
  return (
    // A plain row of our own, not the kit's `MenuItemButton`. The menu draws its
    // data rows with a class of its own rather than by `role`, so nothing the kit
    // offers a foreign row lines up with them: the primitive renders 34px against
    // their 23px, at a different padding and font size, and its stylesheet outranks
    // a plain rule of ours. Owning the row means owning its metrics.
    //
    // They are the measured ones from the row beside it — 23px tall at 12px, with
    // 15px of line box — rather than a house style, so the entry reads as part of
    // the same list. A DSH restyle would strand them; the size of the mismatch is
    // the signal that it has.
    <button
      type="button"
      role="menuitem"
      className="gt-menu-item"
      onClick={() => {
        // The menu is the kit's and closes only on its own actions, so an item that
        // acts has to dismiss it.
        props.dismiss()
        void props.closeAllTabs()
      }}
    >
      {props.t('tabs.closeAll')}
    </button>
  )
}
