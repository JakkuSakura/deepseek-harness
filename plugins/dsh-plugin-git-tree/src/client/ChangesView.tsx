/**
 * The Changes tab body: one changed path, read three ways.
 *
 * The body owns no fetching. Its address is the tab's own, and the value arrives
 * through the `gitdiff` resource this plugin registers, so the tab stays live when
 * the working tree moves underneath it and a re-read that found nothing new
 * publishes nothing.
 *
 * Unified and split are the same diff stated down a column or across two, so both
 * come from the one text the Host sent. The third view — the file itself — is not
 * a third rendering: it hands the path to the product's own preview, because a
 * bundle that draws a second code viewer would be maintaining a worse one. What
 * this tab is for is the change, so choosing the file replaces this tab with it
 * rather than standing a second one beside it — the reader asked to switch views,
 * not to open another tab.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { PathLabel } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { diffLines, fileAddressOfDiff, splitRows, titleOfDiffAddress } from './diff.ts'
import { isImagePath } from './image.ts'
import type { DiffLine } from './diff.ts'
import type {} from './locales.ts'

/** How the tab states one change of text. */
type DiffView = 'unified' | 'split' | 'file'

/** How the tab states one change of picture: the two side by side, or one whole. */
type ImageView = 'compare' | 'whole'

/** One side of a picture change. */
type ImageSide =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready', readonly url: string }
  | { readonly kind: 'missing', readonly reason: string }

/** Every view, in switcher order. */
const VIEWS: readonly { readonly id: DiffView, readonly label: 'diff.view.unified' | 'diff.view.split' | 'diff.view.file' }[] = [
  { id: 'unified', label: 'diff.view.unified' },
  { id: 'split', label: 'diff.view.split' },
  { id: 'file', label: 'diff.view.file' },
]

/** The composed props of a `sidebar.right.pane.tab` body in this plugin's namespace. */
export type ChangesViewProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'gitTree'>
  & {
    /**
     * Read one side of a picture change as something an `img` can be pointed at.
     *
     * A diff is text and an image is not, so the bytes come from the two places
     * that hold them: the committed side from the Host's git, the working side from
     * the workspace-files Remote. The tab holds neither transport itself.
     * @param address - this tab's diff address, which names the Session and path.
     * @param side - which version to read.
     * @param signal - request lifetime.
     * @returns a URL for the picture, and how to release it, or why there is none.
     */
    readonly readImage: (
      address: string,
      side: 'before' | 'after',
      signal: AbortSignal,
    ) => Promise<
      | { readonly url: string, readonly revoke?: () => void }
      | { readonly failure: string }
    >
  }

/** One line of a unified diff. */
function UnifiedLine({ line, t }: { line: DiffLine, t: TranslateNS<'gitTree'> }): ReactNode {
  void t
  return <span className={`gt-diff-line gt-diff-${line.kind}`}>{`${line.text}\n`}</span>
}

/**
 * Draw one path's changes in the chosen view.
 * @param props - composed slot props: the tab's address, the resource hook, copy.
 * @returns the diff, or the state line standing in for it.
 */
export function ChangesView(props: ChangesViewProps): ReactNode {
  const t: TranslateNS<'gitTree'> = props.t
  const [view, setView] = useState<DiffView>('unified')
  const info = props.useTabInfo()
  const address = info.tab.navigation.address
  const resource = props.useResource<'gitdiff'>(address)

  const showFile = useCallback((): void => {
    const file = fileAddressOfDiff(address)
    // `replaceTab` opens in this tab's place and closes this one in the same step,
    // which is what makes the switcher a switcher rather than a way to accumulate
    // tabs for one file.
    if (file !== undefined) info.tab.actions.openResource(file, { replaceTab: true })
  }, [address, info])

  // A picture's bytes are read once per address, and the working side's object URL
  // is released when it is replaced or the tab goes away.
  const image = isImagePath(titleOfDiffAddress(address))
  const [imageView, setImageView] = useState<ImageView>('compare')
  const [before, setBefore] = useState<ImageSide>({ kind: 'loading' })
  const [after, setAfter] = useState<ImageSide>({ kind: 'loading' })
  useEffect(() => {
    if (!image) return undefined
    const controller = new AbortController()
    const load = (
      side: 'before' | 'after',
      settle: (next: ImageSide) => void,
      held: { revoke?: () => void },
    ): void => {
      void props.readImage(address, side, controller.signal).then((result) => {
        if (controller.signal.aborted) return
        if ('url' in result) {
          held.revoke = result.revoke
          settle({ kind: 'ready', url: result.url })
        } else {
          settle({ kind: 'missing', reason: result.failure })
        }
      })
    }
    const beforeHeld: { revoke?: () => void } = {}
    const afterHeld: { revoke?: () => void } = {}
    load('before', setBefore, beforeHeld)
    load('after', setAfter, afterHeld)
    return () => {
      controller.abort()
      beforeHeld.revoke?.()
      afterHeld.revoke?.()
    }
  }, [address, image, props])

  /** One labelled side of a picture change. */
  const imagePane = (side: ImageSide, label: string, whole = false): ReactNode => (
    <figure className="gt-image-pane" data-whole={whole ? 'true' : undefined}>
      <figcaption className="gt-image-label">{label}</figcaption>
      {side.kind === 'ready'
        ? <img className="gt-image" src={side.url} alt={label} />
        : (
          <p className="gt-note" data-git-row={`image-${side.kind}`}>
            {side.kind === 'loading'
              ? t('diff.loading')
              : side.reason === 'no-previous'
                ? t('diff.image.noPrevious')
                : side.reason === 'no-repository'
                  ? t('worktree.noRepository')
                  : t('diff.image.missing')}
          </p>
        )}
    </figure>
  )

  const imageSwitcher = (
    <div className="gt-views" role="tablist" aria-label={t('panel.label')}>
      {(['compare', 'whole'] as const).map(mode => (
        <button
          key={mode}
          type="button"
          role="tab"
          className="gt-view"
          aria-selected={imageView === mode}
          data-active={imageView === mode}
          data-git-image-mode={mode}
          onClick={() => { setImageView(mode) }}
        >
          {t(mode === 'compare' ? 'diff.view.compare' : 'diff.view.whole')}
        </button>
      ))}
    </div>
  )

  const switcher = (
    <div className="gt-views" role="tablist" aria-label={t('panel.label')}>
      {VIEWS.map(entry => (
        <button
          key={entry.id}
          type="button"
          role="tab"
          className="gt-view"
          aria-selected={view === entry.id}
          data-active={view === entry.id}
          data-git-view-mode={entry.id}
          onClick={() => {
            // The file is somewhere else — the product's preview — so choosing it
            // opens that rather than replacing what this tab draws.
            if (entry.id === 'file') { showFile(); return }
            setView(entry.id)
          }}
        >
          {t(entry.label)}
        </button>
      ))}
    </div>
  )

  if (image) {
    return (
      <div className="gt-diff" data-git-diff="image">
        <div className="gt-diff-head">
          <PathLabel path={titleOfDiffAddress(address)} className="gt-diff-path" />
          {imageSwitcher}
        </div>
        {imageView === 'whole'
          ? imagePane(after, t('diff.view.whole'), true)
          : <div className="gt-image-pair">{imagePane(before, t('diff.view.before'))}{imagePane(after, t('diff.view.after'))}</div>}
      </div>
    )
  }

  if (resource.status === 'none') return <p className="gt-note">{t('diff.unsupported')}</p>
  if (resource.value === undefined) return <p className="gt-note">{t('diff.loading')}</p>

  const value = resource.value
  if (value.failure !== null) {
    return <p className="gt-note gt-error">{t('diff.failed', { message: value.failure.message })}</p>
  }

  const lines = diffLines(value.diff)
  return (
    <div className="gt-diff" data-git-diff={value.untracked ? 'untracked' : 'tracked'}>
      <div className="gt-diff-head">
        <PathLabel path={value.path} className="gt-diff-path" />
        {value.untracked ? <span className="gt-diff-badge">{t('diff.untracked')}</span> : null}
        {switcher}
      </div>
      {lines.length === 0
        ? <p className="gt-note" data-git-row="diff-empty">{t('diff.empty')}</p>
        : (
          <pre className="gt-diff-body" data-git-diff-view={view}>
            {view === 'split'
              ? splitRows(value.diff).map((row, index) => (
                row.kind === 'pair'
                  ? (
                    <span key={`${String(index)}`} className="gt-split-row">
                      <span className={`gt-diff-line gt-split-left gt-diff-${row.left?.kind ?? 'blank'}`}>
                        {row.left === null ? '\n' : `${row.left.text}\n`}
                      </span>
                      <span className={`gt-diff-line gt-split-right gt-diff-${row.right?.kind ?? 'blank'}`}>
                        {row.right === null ? '\n' : `${row.right.text}\n`}
                      </span>
                    </span>
                  )
                  // A header cannot be split, so it spans — otherwise the file and
                  // hunk headers would draw as two empty cells and say nothing.
                  : (
                    <span key={`${String(index)}`} className={`gt-diff-line gt-split-span gt-diff-${row.kind}`}>
                      {`${row.text}\n`}
                    </span>
                  )
              ))
              : lines.map((line, index) => (
                <UnifiedLine key={`${String(index)}`} line={line} t={t} />
              ))}
          </pre>
        )}
      {value.truncated ? <p className="gt-note">{t('diff.truncated')}</p> : null}
    </div>
  )
}

/**
 * The Changes tab's chip: the file the tab currently names.
 *
 * Registered rather than left to the registry's captured title, because one tab
 * serves every path — a title read once at open time would keep naming whichever
 * file was opened first.
 * @param props - composed slot props for the pane-tab title seat.
 * @returns the path's last segment.
 */
export function ChangesTitle(props: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  return titleOfDiffAddress(props.useTabInfo().tab.navigation.address)
}
