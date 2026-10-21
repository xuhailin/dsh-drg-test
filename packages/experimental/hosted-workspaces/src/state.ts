/** Durable identity, runtime credentials and browser sessions, owned by the gateway. */
import { createHash, randomBytes } from 'node:crypto'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** Authenticated account identity, independent from display-name changes. */
export type HostedUserId = Branded<'HostedUserId'>
/** Digest of a random browser credential; the raw value is never stored. */
export type HostedSessionId = Branded<'HostedSessionId'>

const userSchema = z.object({
  issuer: z.string(), subject: z.string().min(1), name: z.string(), modelToken: z.string().min(32),
})
const sessionSchema = z.object({ userId: z.string().regex(/^[a-f0-9]{64}$/u), expiresAt: z.number().int().positive() })

/** New gateway-owned storage generation; no published Session fields change. */
export const hostedDomain = defineDomain({
  name: 'hosted_workspaces', version: 1,
  tables: {
    users: domainTable<HostedUserId, z.infer<typeof userSchema>>(userSchema),
    sessions: domainTable<HostedSessionId, z.infer<typeof sessionSchema>>(sessionSchema),
  },
})

/** One verified account and its isolated runtime's restricted model credential. */
export interface HostedUser extends z.infer<typeof userSchema> { readonly id: HostedUserId }
/** One live browser login; the raw credential is used only for host-only cookies. */
export interface HostedLogin { readonly token: string; readonly user: HostedUser; readonly expiresAt: number }

/**
 * Generate a high-entropy opaque cookie or runtime credential.
 * @returns URL-safe random credential.
 */
export function randomCredential(): string { return randomBytes(32).toString('base64url') }

/**
 * Digest a browser credential before persistence or lookup.
 * @param token - raw opaque credential.
 * @returns its branded database key.
 */
export function sessionKey(token: string): HostedSessionId {
  return createHash('sha256').update(token).digest('hex') as HostedSessionId
}

/** Gateway account and login operations over one durable domain handle. */
export class HostedState {
  private writes = Promise.resolve()
  /** @param domain - private gateway storage. @param maxUsers - maximum identities. @param maxSessions - maximum live browser sessions. */
  constructor(
    private readonly domain: Domain<typeof hostedDomain>, private readonly maxUsers: number, private readonly maxSessions: number,
  ) {}

  /**
   * Resolve or durably enroll one verified OIDC identity.
   * @param identity - signature-verified issuer, subject and display label.
   * @returns stable user identity and restricted runtime credential.
   */
  user(identity: { issuer: string; subject: string; name: string }): Promise<HostedUser> {
    const run = this.writes.then(async () => {
      const id = createHash('sha256').update(JSON.stringify([identity.issuer, identity.subject])).digest('hex') as HostedUserId
      const table = this.domain.table('users')
      const existing = table.get(id)
      if (existing !== undefined) return { ...existing, id }
      if ([...table.entries()].length >= this.maxUsers) throw new Error('hosted-workspaces: user capacity reached')
      const record = { ...identity, modelToken: randomCredential() }
      await table.put(id, record)
      return { ...record, id }
    })
    this.writes = run.then(() => {}, () => {})
    return run
  }

  /**
   * Persist one browser login before returning its cookie credential.
   * @param user - account already stored by this gateway.
   * @param ttlMs - absolute login lifetime.
   * @returns the fresh login.
   */
  login(user: HostedUser, ttlMs: number): Promise<HostedLogin> {
    const run = this.writes.then(async () => {
      const table = this.domain.table('sessions')
      const now = Date.now()
      for (const [key, value] of table.entries()) if (value.expiresAt <= now) await table.delete(key)
      if ([...table.entries()].length >= this.maxSessions) throw new Error('hosted-workspaces: browser session capacity reached')
      const token = randomCredential()
      const expiresAt = now + ttlMs
      await table.put(sessionKey(token), { userId: user.id, expiresAt })
      return { token, user, expiresAt }
    })
    this.writes = run.then(() => {}, () => {})
    return run
  }

  /**
   * Resolve a browser credential without extending its lifetime.
   * @param token - cookie supplied by the browser.
   * @returns the live login or undefined.
   */
  find(token: string | undefined): HostedLogin | undefined {
    if (token === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return undefined
    const record = this.domain.table('sessions').get(sessionKey(token))
    if (record === undefined || record.expiresAt <= Date.now()) return undefined
    const id = record.userId as HostedUserId
    const user = this.domain.table('users').get(id)
    return user === undefined ? undefined : { token, user: { ...user, id }, expiresAt: record.expiresAt }
  }

  /**
   * Revoke one browser login durably.
   * @param token - credential being revoked.
   * @returns settles after the session is removed.
   */
  async logout(token: string): Promise<void> { await this.domain.table('sessions').delete(sessionKey(token)) }

  /**
   * Resolve a restricted runtime model credential.
   * @param token - runtime's model-proxy credential.
   * @returns owning account; no upstream credential is returned.
   */
  modelUser(token: string | undefined): HostedUser | undefined {
    if (token === undefined || token.length !== 43) return undefined
    for (const [id, user] of this.domain.table('users').entries()) {
      if (sessionKey(token) === sessionKey(user.modelToken)) return { ...user, id }
    }
    return undefined
  }
}
