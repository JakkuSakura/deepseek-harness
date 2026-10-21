import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'

/** Mutable credential double supporting both record and reference reads. */
export class TestCredentials {
  readonly records = new Map<string, CredentialRecord>()
  readonly values = new Map<string, string>()
  discarded = false

  async readRecord(key: string): Promise<CredentialRecord | undefined> {
    return this.records.get(key)
  }

  async modifyRecord(
    key: string,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(key))
    if (this.discarded) return undefined
    if (next !== undefined) this.records.set(key, next)
    return next
  }

  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    const value = this.values.get(ref)
    return value === undefined ? undefined : { value, source: 'test' }
  }

  asProvider(): CredentialProvider {
    return this as unknown as CredentialProvider
  }
}
