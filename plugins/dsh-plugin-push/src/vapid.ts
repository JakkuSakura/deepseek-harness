/**
 * The server's push identity.
 *
 * A VAPID key pair *is* the certificate in Web Push: it identifies this server to
 * the push services, and the browser's subscription is bound to the public half. It
 * is generated once and then persisted, because rotating it invalidates every
 * existing subscription — the browser would have to subscribe again, which it can
 * only do while someone is looking at the page.
 *
 * @module dsh-plugin-push/vapid
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** The pair, as base64url strings, exactly as the push services expect. */
export interface VapidKeys {
  readonly publicKey: string
  readonly privateKey: string
}

/** The file the pair lives in, under the plugin's data directory. */
export function vapidPath(dataDir: string): string {
  return join(dataDir, 'vapid.json')
}

/**
 * Read the key pair, generating it on first use.
 *
 * Written to a temporary file and renamed into place: a half-written key file would
 * be worse than none, because it would look like an existing identity and quietly
 * break every subscription made against it.
 * @param dataDir - the plugin's data directory.
 * @param generate - produces a fresh pair; injected so tests need no key material.
 * @returns the pair in use.
 */
export async function loadOrCreateVapid(
  dataDir: string,
  generate: () => VapidKeys,
): Promise<VapidKeys> {
  const file = vapidPath(dataDir)
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const { publicKey, privateKey } = parsed as Record<string, unknown>
      if (typeof publicKey === 'string' && publicKey !== '' && typeof privateKey === 'string' && privateKey !== '') {
        return { publicKey, privateKey }
      }
    }
  } catch {
    // Absent or unreadable: fall through and create one.
  }
  const keys = generate()
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${String(process.pid)}.tmp`
  // 0600: the private half signs for this server, and nothing else needs it.
  await writeFile(temporary, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
  return keys
}
