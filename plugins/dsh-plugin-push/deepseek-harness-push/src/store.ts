/**
 * Where the subscriptions live.
 *
 * A subscription is a capability: whoever holds the endpoint can send to that
 * browser. This is a small JSON file under the plugin's data directory rather than
 * anywhere in a repository, and the list is rewritten whole and atomically, because
 * a partially written list would silently drop the browsers it failed to reach.
 *
 * @module dsh-plugin-push/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { StoredSubscription } from './push.ts'

/** The file the subscriptions live in. */
export function subscriptionsPath(dataDir: string): string {
  return join(dataDir, 'subscriptions.json')
}

/**
 * Add a subscription, replacing any earlier one for the same endpoint.
 *
 * Keyed by endpoint because that is the browser's identity here: subscribing twice
 * from the same browser must not produce two notifications.
 * @param list - the subscriptions held.
 * @param subscription - the one to add.
 * @returns the new list.
 */
export function addSubscription(
  list: readonly StoredSubscription[],
  subscription: StoredSubscription,
): StoredSubscription[] {
  return [...list.filter(entry => entry.endpoint !== subscription.endpoint), subscription]
}

/**
 * Drop the subscription for an endpoint.
 * @param list - the subscriptions held.
 * @param endpoint - the endpoint to drop.
 * @returns the new list, unchanged when the endpoint was not there.
 */
export function removeSubscription(
  list: readonly StoredSubscription[],
  endpoint: string,
): StoredSubscription[] {
  return list.filter(entry => entry.endpoint !== endpoint)
}

/**
 * Read the stored subscriptions.
 *
 * A file that cannot be read is an empty list rather than an error: it means nobody
 * has subscribed yet, or the file was damaged, and either way the correct behaviour
 * is to carry on and let the next subscription create it.
 * @param dataDir - the plugin's data directory.
 * @returns the subscriptions, in the order they were stored.
 */
export async function readSubscriptions(dataDir: string): Promise<StoredSubscription[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(subscriptionsPath(dataDir), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is StoredSubscription =>
      typeof entry === 'object' && entry !== null &&
      typeof (entry as StoredSubscription).endpoint === 'string' &&
      typeof (entry as StoredSubscription).keys?.p256dh === 'string' &&
      typeof (entry as StoredSubscription).keys?.auth === 'string')
  } catch {
    return []
  }
}

/**
 * Replace the stored subscriptions.
 * @param dataDir - the plugin's data directory.
 * @param list - the subscriptions to store.
 */
export async function writeSubscriptions(
  dataDir: string,
  list: readonly StoredSubscription[],
): Promise<void> {
  const file = subscriptionsPath(dataDir)
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${String(process.pid)}.tmp`
  await writeFile(temporary, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}
