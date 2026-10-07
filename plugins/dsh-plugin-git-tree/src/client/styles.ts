/**
 * The panel's own stylesheet.
 *
 * The DSH build compiles a `*.module.css` import into a tagged `<style>` written
 * at factory execution; this package has no CSS-module pipeline of its own, so it
 * injects the same kind of tag itself and namespaces every selector under `gt-`.
 * Colours come from the shared design tokens only, so the panel follows the
 * active theme.
 *
 * The marker tokens for added and deleted lines are the readable foreground
 * greens and reds; the code-diff pair is an 8%-alpha background tint and
 * unreadable as text.
 */

/** Identity the injected tag is keyed by; also what a re-import compares against. */
const STYLE_ID = 'dsh-plugin-git-tree/panel.css'

const CSS = `
.gt-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; color: var(--dsw-alias-label-primary); }
.gt-rail { display: flex; flex-direction: column; align-items: center; padding: 6px 0; }
.gt-rail-button { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0; border: 0; border-radius: 8px; background: none; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.gt-rail-button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

.gt-tabs { display: flex; align-items: center; gap: 4px; padding: 0 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.gt-tab { position: relative; padding: 8px 6px; border: 0; background: none; color: var(--dsw-alias-label-tertiary); font: inherit; font-weight: 500; cursor: pointer; }
.gt-tab:hover { color: var(--dsw-alias-label-primary); }
.gt-tab[data-active='true'] { color: var(--dsw-alias-label-primary); }
.gt-tab[data-active='true']::after { content: ''; position: absolute; left: 4px; right: 4px; bottom: -1px; height: 2px; border-radius: 1px; background: var(--dsw-alias-state-business-primary); }

.gt-icon-button { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.gt-icon-button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

/* The status bar: the Session workspace's full path on the left, the git
   summary on the right. PathLabel keeps the trailing segments visible and
   reveals the whole path on hover. */
.gt-status { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-tertiary); font-size: 12px; font-variant-numeric: tabular-nums; }
.gt-status-path { flex: 1 1 auto; min-width: 0; color: var(--dsw-alias-label-secondary); }
.gt-status-note { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 0 12px; }

.gt-list { list-style: none; margin: 0; padding: 0; }
.gt-item { list-style: none; }
.gt-level { list-style: none; margin: 0; padding: 0 0 0 12px; }
.gt-row { display: flex; align-items: center; gap: 6px; width: 100%; padding: 3px 10px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.gt-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.gt-other { cursor: default; color: var(--dsw-alias-label-dimmed); }
.gt-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-change-path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-icon, .gt-file-icon { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); }
.gt-counts { flex: 0 0 auto; display: flex; gap: 6px; font-variant-numeric: tabular-nums; }
.gt-add { color: var(--dsw-alias-file-diff-added-marker); }
.gt-del { color: var(--dsw-alias-file-diff-deleted-marker); }
.gt-badge { flex: 0 0 auto; min-width: 12px; font-size: 11px; font-weight: 600; text-align: center; }
.gt-badge[data-kind='added'], .gt-badge[data-kind='untracked'] { color: var(--dsw-alias-state-success-primary); }
.gt-badge[data-kind='modified'], .gt-badge[data-kind='renamed'], .gt-badge[data-kind='copied'] { color: var(--dsw-alias-state-warn-primary); }
.gt-badge[data-kind='deleted'] { color: var(--dsw-alias-label-error); }
.gt-badge[data-kind='conflicted'] { color: var(--dsw-alias-state-error-primary); }
.gt-dir-files { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.gt-bin { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); }
/* The tab's own action, always visible above the outline. The region this panel
   shadows owned registering a Workspace, so the panel has to own it: with the
   last Workspace deleted there is nothing to start a Session in. Starting a
   Session stays on each Workspace header's + and on the collapsed rail. */
.gt-actions { display: flex; gap: 4px; margin: 6px 6px 2px; }
.gt-action { display: flex; align-items: center; justify-content: center; gap: 3px; flex: 1 1 0; min-width: 0; padding: 5px 4px; border: .5px dashed var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: none; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.gt-action .gt-icon { width: 14px; height: 14px; }
.gt-action:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.gt-action-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-sessions { display: flex; flex-direction: column; }
.gt-workspace { display: flex; flex-direction: column; }
.gt-workspace-title { display: flex; align-items: center; gap: 6px; margin: 0; padding: 8px 10px 4px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.gt-workspace-title .gt-name { text-transform: none; letter-spacing: 0; font-size: 12px; }
/* A Session row: the open button, then the hover actions that sit beside it. */
.gt-session { --gt-actions-w: 46px; display: flex; align-items: center; gap: 2px; padding-right: 6px; padding-left: 22px; border-radius: var(--dsw-radius-sm); }
.gt-session:hover { background: var(--dsw-alias-interactive-bg-hover); }
.gt-session[data-active='true'] { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); font-weight: 500; }
.gt-session[data-busy='true'] { opacity: .6; }
.gt-session-open { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; padding: 3px 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.gt-session-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: padding-right .12s var(--ds-ease-in-out); }
/* The title gives the actions their width only while they are shown, so an idle row
   spends nothing on them and the icons never sit over the text. The row's hover fill
   is a 10% tint, so covering the text with it — the obvious alternative — would have
   shown the text through. */
.gt-session:hover .gt-session-title, .gt-session:focus-within .gt-session-title { padding-right: calc(var(--gt-actions-w) + 4px); }
/* Revealed on hover and on focus-within. Opacity rather than display, because a
   display:none control is unreachable by keyboard: it can never take focus, so
   focus-within could never reveal it. */
/* Laid over the row's trailing edge rather than into it, so an idle outline spends
   none of its width on buttons it is not showing; the title reserves that same
   width while they are shown, which is what keeps them off the text. */
.gt-row-actions { position: absolute; inset: 0 0 0 auto; width: var(--gt-actions-w); display: inline-flex; align-items: center; justify-content: flex-end; gap: 2px; padding-right: 4px; background: none; opacity: 0; transition: opacity .12s var(--ds-ease-in-out); }
.gt-session:hover .gt-row-actions, .gt-session:focus-within .gt-row-actions { opacity: 1; }
.gt-workspace-title .gt-icon-button { opacity: 0; transition: opacity .12s var(--ds-ease-in-out); }
.gt-workspace-title:hover .gt-icon-button, .gt-workspace-title:focus-within .gt-icon-button { opacity: 1; }
/* An empty Workspace exists only to be started in or removed, so its actions stay
   visible instead of hiding behind a hover. */
.gt-workspace-title[data-empty='true'] .gt-icon-button { opacity: 1; }
.gt-workspace-title[data-busy='true'] { opacity: .6; }
.gt-danger:hover { color: var(--dsw-alias-state-error-primary); }
.gt-rename { box-sizing: border-box; width: calc(100% - 12px); margin: 1px 6px; padding: 3px 6px; border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-primary); font: inherit; outline: none; }
.gt-rename:focus { border-color: var(--dsw-alias-state-business-primary); }
.gt-dot-unused { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); }
.gt-note { margin: 0; padding: 4px 10px; color: var(--dsw-alias-label-tertiary); list-style: none; }
.gt-error { color: var(--dsw-alias-label-error); }
/* A submodule is a folder in the outline, marked as the separate repository it is. */
/* One Session's state: a ring that turns while work is in flight, a filled dot
   when it has finished, and an orange one when it is waiting on the reader. */
.gt-session-mark { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 50%; }
.gt-session-mark[data-status='unread'] { background: var(--dsw-alias-state-success-primary); }
.gt-session-mark[data-status='input'] { background: var(--dsw-alias-state-warn-primary); }
/* Unsent input: the reader's own, in the brand blue. */
.gt-session-mark[data-status='draft'] { background: var(--dsw-alias-state-business-primary); }
.gt-session-mark[data-status='running'] { background: none; border: 1.5px solid var(--dsw-alias-border-l3); border-top-color: var(--dsw-alias-brand-primary); animation: gt-session-spin 900ms linear infinite; }
@keyframes gt-session-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  /* Without the turn, the ring still reads as different from a filled dot. */
  .gt-session-mark[data-status='running'] { animation: none; border-top-color: var(--dsw-alias-label-secondary); }
}
/* Said, not shown: the state a colour and a spin cannot carry. */
/*
 * Show a running shell in full.
 *
 * DSH caps its own tool cards: the terminal block at a 224px output height variable,
 * the input/output section at 150px, and the card itself at 360px — each with its own
 * scrollbar, so a long command's output is a window you have to drag rather than
 * something you can read. Overriding the variable and lifting the caps is all it takes,
 * and it needs no patch: the class names are CSS modules with a per-build hash prefix,
 * so they are matched by their stable suffix.
 *
 * (No backticks in this comment: it lives inside a template literal, and the first
 * version of it ended the string and broke the build.)
 */
/*
 * The variable is shared by three consumers — the tool row, the jobs panel and the
 * plugin manager — so it is overridden at the root rather than on one row's classes.
 * Scoping it to the tool row's classes, as the first version did, silently missed a
 * job's output panel, which is the same terminal in a different place.
 */
:root {
  --dsl-terminal-output-max-height: none;
}
[class*='_ioSection'],
[class*='_card'] {
  max-height: none;
}

.gt-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* A drag in flight marks where the drop would land, and the dragged rows read as
   picked up rather than as another row. */
.gt-workspace-title[data-drop='true'] { box-shadow: inset 0 2px 0 var(--dsw-alias-brand-primary); }
.gt-session[data-drop='true']::before { content: ''; position: absolute; inset: 0 0 auto; height: 2px; background: var(--dsw-alias-brand-primary); }
/* The mark sits on the edge the drop actually lands on, which for a downward drag
   is the target's far side — the row is going into its place, not above it. */
.gt-session[data-drop='true'][data-drop-side='after']::before { inset: auto 0 0; }
.gt-session { position: relative; }
.gt-sessions[data-drop='true'] .gt-workspace:last-child .gt-list { box-shadow: inset 0 -2px 0 var(--dsw-alias-brand-primary); }
.gt-submodule { flex: 0 0 auto; padding: 0 5px; border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); color: var(--dsw-alias-label-tertiary); font-size: 11px; }
/* The Changes tab in the right Sidebar: one path's unified diff. Its own pane is
   wide, so lines keep their natural length and the body scrolls rather than wraps. */
.gt-diff { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 12px; }
.gt-diff-head { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.gt-diff-path { flex: 1 1 auto; min-width: 0; }
.gt-diff-badge { flex: 0 0 auto; padding: 0 5px; border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); color: var(--dsw-alias-label-tertiary); font-size: 11px; }
/* The one row this bundle adds to the tab menu, at the metrics the menu's own rows
   are measured to use — see the component for why it is a row of ours at all. */
.gt-menu-item { display: flex; align-items: center; width: 100%; padding: 4px 7px; border: 0; border-radius: var(--dsw-radius-sm); background: none; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 15px; text-align: left; cursor: pointer; }
.gt-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover); }

/* The rolling token rate, told apart from the change counts beside it. */
.gt-rate { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }

/* A change of picture: the two versions side by side, or one of them whole. */
.gt-image-pair { flex: 1 1 auto; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px; padding: 6px; overflow: auto; }
.gt-image-pane { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; margin: 0; }
.gt-image-label { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
/* Contained, so the two sides are comparable at a glance; the whole view is the
   natural size, because that is the one place a reader wants the real pixels. */
.gt-image { max-width: 100%; max-height: 100%; object-fit: contain; border: .5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); background: repeating-conic-gradient(var(--dsw-alias-bg-base) 0% 25%, transparent 0% 50%) 50% / 16px 16px; }
.gt-diff[data-git-diff='image'] .gt-image-pane { flex: 1 1 auto; }
/* The whole view is the one place a reader wants the real pixels, so it is not
   stretched to the pane; the compare view contains both so they stay comparable. */
.gt-image-pane[data-whole='true'] .gt-image { max-width: none; max-height: none; }

/* The three readings of one change: down a column, across two, or the file. */
.gt-views { flex: 0 0 auto; display: flex; gap: 2px; }
.gt-view { padding: 2px 7px; border: .5px solid transparent; border-radius: var(--dsw-radius-sm); background: none; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 11px; cursor: pointer; }
.gt-view[data-active='true'] { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); }
.gt-view:hover { color: var(--dsw-alias-label-primary); }
/* The split body is two columns of the same columns of text: each row states the
   removal and its replacement, and a row that has neither stays blank rather than
   shifting the pairing. */
.gt-diff-body[data-git-diff-view='split'] { display: block; }
.gt-split-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.gt-split-left { border-right: 1px solid var(--dsw-alias-border-l1); }
.gt-split-span { display: block; grid-column: 1 / -1; }
.gt-diff-blank { background: none; }
.gt-diff-body { flex: 1 1 auto; min-height: 0; margin: 0; padding: 6px 0; overflow: auto; font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; line-height: 1.5; tab-size: 4; }
.gt-diff-line { display: block; padding: 0 10px; white-space: pre; }
.gt-diff-add { background: var(--dsw-alias-code-diff-added); }
.gt-diff-del { background: var(--dsw-alias-code-diff-deleted); }
.gt-diff-add::before, .gt-diff-del::before { content: ''; }
.gt-diff-hunk { color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-base); }
.gt-diff-file { color: var(--dsw-alias-label-primary); font-weight: 600; }
.gt-diff-meta, .gt-diff-nonewline { color: var(--dsw-alias-label-tertiary); }
.gt-diff-context { color: var(--dsw-alias-label-secondary); }

/* One entry this bundle adds to a right-Sidebar tab's own menu. The kit draws the
   menu and its own rows; this one only has to read as a row beside them. */
`

/**
 * Rules that reach outside the panel, and why they have to.
 *
 * The shell owns the New Session button: `ui-sidebar` declares no slot for it, so
 * there is no registration that could remove it. The panel starts Sessions from
 * each Workspace header's own + and from the collapsed rail, so the shell's
 * button is redundant in both states. It is hidden by its CSS-module local name
 * rather than by its aria-label, which is copy and therefore changes with the
 * language, and scoped under the layout's own sidebar seat. A rename upstream
 * stops the rule matching, which brings the button back rather than breaking
 * anything.
 */
const SHELL_RULES = `
[data-slot='sidebar'] [class*='_newSession'] { display: none; }
`

/**
 * Write the panel's stylesheet once per document.
 *
 * Called from the client plugin body, so the tag appears when the plugin mounts
 * and a re-import after HMR finds the existing tag by its key.
 */
export function injectGitTreeStyles(): void {
  if (typeof document === 'undefined') return
  const selector = `style[data-plugin-css="${STYLE_ID}"]`
  if (document.querySelector(selector) !== null) return
  const tag = document.createElement('style')
  tag.dataset['plugin'] = 'dsh-plugin-git-tree'
  tag.dataset['pluginCss'] = STYLE_ID
  tag.textContent = CSS + SHELL_RULES
  document.head.appendChild(tag)
}
