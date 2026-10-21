/** Account and browser-login persistence through the real Cordis JSON storage composition. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { HostedState, hostedDomain, randomCredential, sessionKey } from '../src/state.ts'

const ALICE = { issuer: 'https://sso.example.test', subject: 'alice', name: 'Alice' }

async function harness(maxUsers = 4, maxSessions = 200) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hosted-state-'))
  const contexts: Context[] = []
  onTestFinished(async () => {
    for (const ctx of contexts) await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  async function open() {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    const domain = await ctx.storageDomain.open(hostedDomain)
    return { ctx, domain, state: new HostedState(domain, maxUsers, maxSessions) }
  }
  return { root, open, ...await open() }
}

describe('HostedState', () => {
  it('keeps account and model credentials stable for one issuer and subject', async () => {
    const { state } = await harness()
    const alice = await state.user(ALICE)
    const renamed = await state.user({ ...ALICE, name: 'New display label' })
    const otherIssuer = await state.user({ ...ALICE, issuer: 'https://other-sso.example.test' })
    const otherSubject = await state.user({ ...ALICE, subject: 'bob' })

    expect(alice.id).toMatch(/^[a-f0-9]{64}$/u)
    expect(alice.modelToken).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(renamed.id).toBe(alice.id)
    expect(renamed.modelToken).toBe(alice.modelToken)
    expect(new Set([alice.id, otherIssuer.id, otherSubject.id]).size).toBe(3)
    expect(state.modelUser(alice.modelToken)?.id).toBe(alice.id)
    expect(state.modelUser(undefined)).toBeUndefined()
    expect(state.modelUser('short')).toBeUndefined()
    expect(state.modelUser(randomCredential())).toBeUndefined()
  })

  it('persists browser logins by digest and reopens their account and revocation state', async () => {
    const world = await harness()
    const alice = await world.state.user(ALICE)
    const first = await world.state.login(alice, 60_000)
    const second = await world.state.login(alice, 60_000)
    expect(world.state.find(first.token)).toEqual(first)
    expect(first.token).not.toBe(second.token)

    const persisted = await readFile(join(world.root, 'hosted_workspaces.json'), 'utf8')
    expect(persisted).not.toContain(first.token)
    expect(persisted).not.toContain(second.token)
    expect(persisted).toContain(sessionKey(first.token))
    await world.ctx.fiber.dispose()
    const reopened = await world.open()
    expect(reopened.state.find(first.token)).toEqual(first)
    expect((await reopened.state.user(ALICE)).modelToken).toBe(alice.modelToken)
    await reopened.state.logout(first.token)
    await reopened.state.logout(first.token)
    expect(reopened.state.find(first.token)).toBeUndefined()
    expect(reopened.state.find(second.token)).toEqual(second)

    await reopened.ctx.fiber.dispose()
    const final = await world.open()
    expect(final.state.find(first.token)).toBeUndefined()
    expect(final.state.find(second.token)).toEqual(second)
  })

  it('rejects absent, malformed, unknown and expired browser credentials', async () => {
    const { state } = await harness()
    const alice = await state.user(ALICE)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    onTestFinished(() => { clock.mockRestore() })
    const login = await state.login(alice, 1_000)

    expect(state.find(undefined)).toBeUndefined()
    expect(state.find('not a cookie')).toBeUndefined()
    expect(state.find('!'.repeat(43))).toBeUndefined()
    expect(state.find(randomCredential())).toBeUndefined()
    clock.mockReturnValue(login.expiresAt - 1)
    expect(state.find(login.token)?.expiresAt).toBe(login.expiresAt)
    clock.mockReturnValue(login.expiresAt)
    expect(state.find(login.token)).toBeUndefined()
  })

  it('denies a stored session after its owning account record is missing', async () => {
    const world = await harness()
    const alice = await world.state.user(ALICE)
    const login = await world.state.login(alice, 60_000)
    expect(world.state.find(login.token)?.user.id).toBe(alice.id)
    await world.domain.table('users').delete(alice.id)
    expect(world.state.find(login.token)).toBeUndefined()
    await world.ctx.fiber.dispose()
    const reopened = await world.open()
    expect(reopened.state.find(login.token)).toBeUndefined()
  })

  it('serializes duplicate enrollment and stores one runtime credential', async () => {
    const { state, domain } = await harness()
    const enrolled = await Promise.all(Array.from({ length: 12 }, () => state.user(ALICE)))

    expect(new Set(enrolled.map(user => user.id)).size).toBe(1)
    expect(new Set(enrolled.map(user => user.modelToken)).size).toBe(1)
    expect([...domain.table('users').entries()]).toHaveLength(1)
    expect(state.modelUser(enrolled[0]?.modelToken)?.subject).toBe(ALICE.subject)
  })

  it('limits new identities while keeping enrolled accounts usable after a rejected write', async () => {
    const { state, domain } = await harness(1)
    const [first, second] = await Promise.allSettled([
      state.user(ALICE),
      state.user({ ...ALICE, subject: 'bob', name: 'Bob' }),
    ])
    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('rejected')
    await expect(state.user(ALICE)).resolves.toMatchObject({ subject: 'alice' })
    await expect(state.user({ ...ALICE, subject: 'carol' })).rejects.toThrow('user capacity reached')
    expect([...domain.table('users').entries()]).toHaveLength(1)
  })

  it('serializes browser-session admission and removes expired sessions before accepting another login', async () => {
    const { state, domain } = await harness(4, 1)
    const user = await state.user(ALICE)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    onTestFinished(() => { clock.mockRestore() })
    const attempts = await Promise.allSettled([state.login(user, 1_000), state.login(user, 1_000)])
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(attempt => attempt.status === 'rejected')).toHaveLength(1)
    const admitted = attempts.find(attempt => attempt.status === 'fulfilled')
    if (admitted?.status !== 'fulfilled') throw new Error('Concurrent login did not admit one browser session')
    expect(state.find(admitted.value.token)).toEqual(admitted.value)
    await expect(state.login(user, 1_000)).rejects.toThrow('browser session capacity reached')
    clock.mockReturnValue(admitted.value.expiresAt)
    const replacement = await state.login(user, 1_000)
    expect(replacement.token).not.toBe(admitted.value.token)
    expect(state.find(admitted.value.token)).toBeUndefined()
    expect(state.find(replacement.token)).toEqual(replacement)
    expect([...domain.table('sessions').entries()]).toHaveLength(1)
  })
})
