/** Connection registration of deployment-owned browser-session authenticators. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { BrowserAuth } from '../src/browser-auth.ts'
import { HostConnectionService } from '../src/rpc-host.ts'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { RecordCredentials } from './browser-credentials.ts'

function credentials(store: RecordCredentials): CredentialProvider {
  return store as unknown as CredentialProvider
}

async function mounted(): Promise<{
  readonly connection: HostConnectionService
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const auth = await BrowserAuth.create(ctx.root, credentials(new RecordCredentials()), 30)
  const fiber = ctx.plugin((pluginCtx) => {
    new HostConnectionService(pluginCtx, [], auth)
  })
  await fiber.await()
  return {
    connection: ctx.get('connection') as HostConnectionService,
    dispose: () => fiber.dispose(),
  }
}

describe('HostConnectionService browser authenticators', () => {
  it('admits a request from a registered external credential until it is withdrawn', async () => {
    const { connection, dispose } = await mounted()
    const registered = connection.registerBrowserAuthenticator({
      isAuthenticated: (request) => {
        const headers = request.headers
        return (headers instanceof Headers ? headers.get('cookie') : headers.cookie) === 'sso=ok'
      },
    })

    expect(connection.admit({ headers: { host: '127.0.0.1:3080', cookie: 'sso=ok' } })).toHaveProperty('peer')
    expect(connection.admit({ headers: { host: '127.0.0.1:3080' } })).toEqual({ rejection: 401 })
    expect(connection.admit({ headers: { host: 'evil.example', cookie: 'sso=ok' } })).toEqual({ rejection: 403 })
    registered()
    expect(connection.admit({ headers: { host: '127.0.0.1:3080', cookie: 'sso=ok' } })).toEqual({ rejection: 401 })
    await dispose()
  })
})
