import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection/src/rpc-host.ts'
import * as plugin from '../src/index.ts'

const config = {}

describe('Clinical-result viewer Host configuration', () => {
  it('loads public settings from cordis.yml and withdraws the authenticated route on disposal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'clinical-results-'))
    const path = join(dir, 'cordis.yml')
    const ctx = new Context()
    try {
      await ctx.plugin((owner) => { new HostConnectionService(owner, [], {} as BrowserAuth) }).await()
      await writeFile(path, '- name: cordis:clinical-results\n  id: clinical-results\n  config: {}\n')
      await ctx.plugin(Loader).await()
      Object.assign(ctx.loader.builtins, { include: Include, 'clinical-results': plugin })
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
      await ctx.loader.await()
      const connection = ctx.get('connection') as HostConnectionService
      const shared = connection.createSharedFetchHandler('/api')
      const response = await shared.fetch(new Request('http://host/api/clinical-results/config'), connection.browserPeer)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({
        ...config, allowedOrigins: [], requestTimeoutMs: 30000, maxPendingRequests: 4, maxMessageBytes: 8192,
        maxActionReceipts: 256, directoryPageSize: 20,
      })
      const entry = [...ctx.loader.entries()].find(value => value.options.id === 'clinical-results')!
      await entry.fiber?.dispose()
      expect((await shared.fetch(new Request('http://host/api/clinical-results/config'), connection.browserPeer)).status).toBe(404)
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each(['*', 'null', 'https://emr.example/path', 'https://emr.example/', 'file:///tmp', 'https://user:pass@emr.example'])
  ('rejects non-origin allowlist values at startup: %s', (origin) => {
    const ctx = new Context()
    const register = vi.fn()
    ctx.provide('connection', { fetch: { register } } as never)
    expect(() => { plugin.apply(ctx, plugin.Config({ ...config, allowedOrigins: [origin] })) }).toThrow()
    expect(register).not.toHaveBeenCalled()
  })
})
