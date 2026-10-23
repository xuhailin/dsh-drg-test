// @vitest-environment jsdom
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { afterEach, describe, expect, it } from 'vitest'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import * as themeHost from '@deepseek-ai/dsh-client-ui-theme'
import * as plugin from '../src/index.ts'

afterEach(() => {
  document.body.removeAttribute('data-ds-dark-theme')
  document.body.removeAttribute('style')
  delete document.documentElement.dataset.dsThemeSource
})

describe('Synyi theme bootstrap composition', () => {
  it.each([
    ['light', true, '#ffffff'],
    ['dark', false, '#151e2c'],
    ['system', false, '#ffffff'],
    ['system', true, '#151e2c'],
  ] as const)('starts %s with OS dark=%s before client activation', async (preference, systemDark, background) => {
    const dir = await mkdtemp(join(tmpdir(), 'synyi-theme-'))
    const ctx = new Context()
    try {
      const path = join(dir, 'cordis.yml')
      await writeFile(path, `- name: cordis:synyi-theme\n  id: synyi-theme\n- name: cordis:theme\n  id: theme\n  config:\n    preference: ${preference}\n`)
      await ctx.plugin(Loader).await()
      Object.assign(ctx.loader.builtins, { include: Include, theme: themeHost, 'synyi-theme': plugin })
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
      await ctx.loader.await()
      const collect = (): IndexInjection[] => {
        const rows: IndexInjection[] = []
        ctx.emit('webserver/index-inject', rows)
        return rows
      }
      const rows = collect()
      expect(rows).toHaveLength(4)
      expect(rows[2]).toEqual({ kind: 'style', text: 'html body{background-color:var(--dsw-alias-bg-base,light-dark(#ffffff,#151e2c));--dsh-boot-bg:light-dark(#ffffff,#151e2c)}' })
      for (const row of rows) {
        if (row.kind === 'script') runInNewContext(row.text, { document, matchMedia: () => ({ matches: systemDark }) })
      }
      expect(document.documentElement.dataset.dsThemeSource).toBe(preference)
      expect(document.body.style.getPropertyValue('--dsw-alias-bg-base')).toBe(background)
      expect(document.body.style.getPropertyValue('--dsh-boot-bg')).toBe(background)
      expect(document.body.style.getPropertyValue('--dsw-radius-panel')).toBe('8px')
      const entry = [...ctx.loader.entries()].find(value => value.options.id === 'synyi-theme')
      await entry?.fiber?.dispose()
      expect(collect()).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
