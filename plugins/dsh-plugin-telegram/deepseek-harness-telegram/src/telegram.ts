/**
 * The pure half of the Telegram bridge: what an update means, who may send one,
 * where the poll resumes, and how a long reply is delivered.
 *
 * Nothing here talks to Telegram, so every rule the bridge depends on is decided by
 * a function that can be tested without a bot, a token or a network.
 *
 * @module dsh-plugin-telegram/telegram
 */

/** One message, reduced to what a bridge needs from it. */
export interface TelegramMessage {
  /** The chat it arrived in; a reply goes back here. */
  readonly chatId: string
  /** Who sent it, which is what an allow-list is actually about. */
  readonly userId: string
  /** The message's own id, for quoting or threading. */
  readonly messageId: number
  /** The text. Commands arrive as text, so nothing is parsed out of it here. */
  readonly text: string
}

/** One parsed update, with the id the next poll has to resume after. */
export interface ParsedUpdate {
  readonly updateId: number
  readonly message: TelegramMessage
}

/** The Bot API caps a message at 4096 characters. */
export const MESSAGE_LIMIT = 4096

/** The longest a single long-poll may wait. */
export const MAX_POLL_SECONDS = 50

/**
 * Read one `getUpdates` entry.
 *
 * Only plain text messages are bridged. An edit, a callback from an old keyboard, a
 * sticker or a photo all reach the bot and none of them is a task, so they are
 * dropped rather than guessed at — the alternative is a session started by someone
 * uploading a picture.
 * @param update - one entry from the Bot API.
 * @returns the message and its update id, or null when this entry is not one.
 */
export function parseUpdate(update: unknown): ParsedUpdate | null {
  if (typeof update !== 'object' || update === null) return null
  const record = update as Record<string, unknown>
  const updateId = record['update_id']
  if (typeof updateId !== 'number' || !Number.isFinite(updateId)) return null
  const message = record['message']
  if (typeof message !== 'object' || message === null) return null
  const fields = message as Record<string, unknown>
  const text = fields['text']
  const messageId = fields['message_id']
  const chat = fields['chat']
  const from = fields['from']
  if (typeof text !== 'string' || text.trim() === '') return null
  if (typeof messageId !== 'number') return null
  if (typeof chat !== 'object' || chat === null) return null
  if (typeof from !== 'object' || from === null) return null
  const chatId = (chat as Record<string, unknown>)['id']
  const userId = (from as Record<string, unknown>)['id']
  if (typeof chatId !== 'number' && typeof chatId !== 'string') return null
  if (typeof userId !== 'number' && typeof userId !== 'string') return null
  return {
    updateId,
    message: {
      chatId: String(chatId),
      userId: String(userId),
      messageId,
      text,
    },
  }
}

/**
 * Whether a message is allowed to drive this machine.
 *
 * Empty lists allow **nobody**. A Telegram message becomes a prompt that can run
 * tools here, so the default has to be closed: a bot token leaks, and a bridge that
 * trusts whoever finds it is a remote shell. Both lists must agree when both are
 * given.
 * @param message - the message to judge.
 * @param allowedChats - chats that may send; empty allows none.
 * @param allowedUsers - users that may send; empty allows none.
 * @returns true only when both lists admit it.
 */
export function isAllowed(
  message: TelegramMessage,
  allowedChats: readonly string[],
  allowedUsers: readonly string[],
): boolean {
  if (allowedChats.length === 0 || allowedUsers.length === 0) return false
  return allowedChats.includes(message.chatId) && allowedUsers.includes(message.userId)
}

/**
 * The offset the next poll should carry.
 *
 * Telegram redelivers everything at or after the offset, so it advances past the
 * highest id seen — never past the *last* entry, which is not the same thing when
 * the batch arrives out of order.
 * @param updateIds - the ids one batch held.
 * @param current - the offset the batch was fetched with.
 * @returns the offset to fetch with next.
 */
export function nextOffset(updateIds: readonly number[], current: number): number {
  let highest = current - 1
  for (const id of updateIds) {
    if (Number.isFinite(id) && id > highest) highest = id
  }
  return highest + 1
}

/**
 * Split a reply into messages Telegram will accept.
 *
 * Cuts at a newline when one is close enough to the limit to keep paragraphs
 * together, and at the limit otherwise. No character is dropped or duplicated: a
 * harness that silently truncates its own output is worse than one that sends five
 * messages.
 * @param text - the whole reply.
 * @param limit - the per-message cap.
 * @returns one or more messages, in order.
 */
export function chunks(text: string, limit: number = MESSAGE_LIMIT): string[] {
  if (text === '') return []
  if (limit <= 0) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    // Prefer the last newline once the message is at least half full, so paragraphs
    // stay together without producing stubs. Below that, the limit is used: a very
    // short first message reads worse than a split mid-paragraph.
    const newline = window.lastIndexOf('\n')
    const cut = newline >= Math.floor(limit / 2) ? newline + 1 : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest !== '') out.push(rest)
  return out
}

/**
 * How long to wait before the next poll after a failure.
 *
 * Doubles to a ceiling. A Telegram poll that fails is usually a network blip or a
 * rate limit, and hammering either is how a bridge gets blocked.
 * @param attempt - consecutive failures so far, counting this one.
 * @returns milliseconds to wait, never zero.
 */
export function retryDelayMs(attempt: number): number {
  const base = 1000
  const ceiling = 30_000
  if (!Number.isFinite(attempt) || attempt < 1) return base
  return Math.min(ceiling, base * 2 ** Math.min(attempt - 1, 10))
}
