/**
 * A Telegram bridge for the DeepSeek Harness.
 *
 * Messages arrive by **long polling**, so the bridge needs no public URL, no
 * certificate and no inbound port — it works behind NAT and on a laptop, which is
 * where this harness runs. Telegram is the only party that has to be reachable.
 *
 * An allowed message becomes a `VerifiedWebhookDelivery` handed to the harness's own
 * **webhook runtime**, which is the piece that already knows how to turn an event
 * into a Workspace-backed Session with a prompt. This plugin therefore does not
 * create Sessions, does not pick models, and does not know what a route is: it
 * authenticates and translates, and the runtime's configured rules decide the rest.
 *
 * The security boundary is the allow-list, and it fails closed — see `isAllowed` for
 * why an empty list means nobody rather than everybody.
 *
 * @module dsh-plugin-telegram
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { VerifiedWebhookDelivery } from '@deepseek-ai/dsh-webhook'
import { MAX_POLL_SECONDS, isAllowed, nextOffset, parseUpdate, retryDelayMs } from './telegram.ts'

declare module '@deepseek-ai/dsh-webhook' {
  /** The event this bridge delivers: one Telegram message. */
  interface WebhookEventMap {
    telegram: {
      readonly chatId: string
      readonly userId: string
      readonly messageId: number
      readonly text: string
    }
  }
}

/** Cordis plugin name. */
export const name = 'telegram'

/** The runtime that turns a delivery into a Session, and the credential store. */
export const inject = ['webhookRuntime', 'credentials']

/** What the plugin needs from its row. */
export interface TelegramConfig {
  /** Credential *reference* — an environment variable name — never a token. */
  readonly botTokenRef: string
  /** Chats that may send. Empty allows none. */
  readonly allowedChats?: readonly string[]
  /** Users that may send. Empty allows none. */
  readonly allowedUsers?: readonly string[]
  /** Where a notice goes when nothing more specific is known. */
  readonly notifyChat?: string
  /** Long-poll seconds; capped, because Telegram holds a poll open for less. */
  readonly pollTimeoutSeconds?: number
  /** API base, so tests can point at a stub rather than at Telegram. */
  readonly apiBase?: string
}

/** Wait, without keeping the process alive for it. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

/**
 * Register the bridge.
 * @param ctx - Host context carrying the webhook runtime and the credential store.
 * @param config - this plugin's row.
 */
export function apply(ctx: Context, config: TelegramConfig): void {
  const allowedChats = config.allowedChats ?? []
  const allowedUsers = config.allowedUsers ?? []
  const api = config.apiBase ?? 'https://api.telegram.org'
  const seconds = Math.min(config.pollTimeoutSeconds ?? 25, MAX_POLL_SECONDS)

  /**
   * The token, resolved per operation.
   *
   * The credential contract is explicit that a reference is resolved each time
   * rather than cached, so a rotated token reaches the next poll without a restart —
   * and this plugin never holds a value it could log.
   * @returns the token, or null when the reference does not resolve.
   */
  const token = async (): Promise<string | null> => {
    try {
      const resolved = await ctx.credentials.resolve(config.botTokenRef as CredentialRef)
      if (typeof resolved === 'string' && resolved !== '') return resolved
      const value = (resolved as { value?: unknown } | null)?.value
      return typeof value === 'string' && value !== '' ? value : null
    } catch (error: unknown) {
      ctx.logger.warn(`telegram: ${config.botTokenRef} is not resolvable: ${String(error)}`)
      return null
    }
  }

  /**
   * Poll for as long as the plugin is loaded.
   * @param signal - aborted when the plugin unloads.
   */
  const poll = async (signal: AbortSignal): Promise<void> => {
    let offset = 0
    let attempt = 0
    while (!signal.aborted) {
      const secret = await token()
      if (secret === null) {
        // Backed off rather than retried hot: an unresolved reference is not going
        // to resolve on the next millisecond.
        await sleep(retryDelayMs(attempt += 1), signal)
        continue
      }
      try {
        const response = await fetch(
          `${api}/bot${secret}/getUpdates?timeout=${String(seconds)}&offset=${String(offset)}`,
          { signal },
        )
        if (!response.ok) throw new Error(`getUpdates answered ${String(response.status)}`)
        const body = await response.json() as { result?: unknown }
        const updates = Array.isArray(body.result) ? body.result : []
        attempt = 0
        const seen: number[] = []
        for (const update of updates) {
          const parsed = parseUpdate(update)
          const updateId = (update as { update_id?: unknown } | null)?.update_id
          if (typeof updateId === 'number') seen.push(updateId)
          if (parsed === null) continue
          if (!isAllowed(parsed.message, allowedChats, allowedUsers)) {
            // Said out loud, because a message that silently does nothing is the
            // hardest kind of allow-list mistake to notice.
            ctx.logger.warn(
              `telegram: ignored a message from chat ${parsed.message.chatId} user ${parsed.message.userId}`,
            )
            continue
          }
          ctx.webhookRuntime.dispatch({
            kind: 'telegram',
            // Branded by the runtime's own constructors; this is the adapter seam.
            source: 'telegram',
            deliveryId: String(parsed.updateId),
            event: parsed.message,
            receivedAt: Date.now(),
          } as unknown as VerifiedWebhookDelivery<'telegram'>)
        }
        offset = nextOffset(seen, offset)
      } catch (error: unknown) {
        if (signal.aborted) return
        ctx.logger.warn(`telegram: poll failed: ${String(error)}`)
        await sleep(retryDelayMs(attempt += 1), signal)
      }
    }
  }

  ctx.effect(() => {
    const controller = new AbortController()
    void poll(controller.signal)
    return () => { controller.abort() }
  }, 'telegram: getUpdates loop')
}
