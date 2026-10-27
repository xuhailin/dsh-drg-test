import { readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const fixture = fileURLToPath(new URL('./snapshot-fixture.ts', import.meta.url))

describe('pathway evidence through the shipped headless profile', () => {
  it('uses three scoped tools through HTTP and persists evidence plus a visible denial for reference-only analysis', async () => {
    const patchName = 'pathway-reader.patch.yml'
    const output = await runLoaderSmoke({ label: 'pathway-reader', tempDirPrefix: 'dsh-pathway-reader-composition-',
      binScript: join(root, 'apps/cli/src/bin.ts'), tsconfigPath: join(root, 'tsconfig.json'), sourceImport: 'tsx/esm', configPath: patchName,
      binArgs: ['--profile', 'headless', '--patch', patchName, '--json', '读取合成路径、历史人群和病例依据，给出仅供参考的分析；不要写入业务系统。'],
      env: { DEEPSEEK_API_KEY: undefined, PATHWAY_FIXTURE_TOKEN: 'synthetic-pathway-runtime-token', TZ: 'UTC' },
      prepare: async (cwd) => {
        const existing = await readFile(join(root, 'snapshots/session/clinical-pathway-analysis/cordis.yml'), 'utf8')
        const fixtureStart = existing.indexOf('    - id: clinical-pathway-fixture')
        if (fixtureStart < 0) throw new Error('Existing pathway composition fixture row is unavailable')
        const patch = existing.slice(0, fixtureStart) + [
          '    - id: pathway-reader-fixture', `      name: ${JSON.stringify(fixture)}`, '      config:', '        scriptModel: true', '        saveRequests: true',
          '- id: llm-deepseek', '  disabled: true', '- id: session-title-llm', '  disabled: true',
          '- id: agent-default-model', '  config:', '    provider: pathway-fixture', '    model: fixture',
          '- id: session-persistence-jsonl', '  config:', "    root: !!js dshHomePath('sessions')", '    compression: none', '',
        ].join('\n')
        await writeFile(join(cwd, patchName), patch)
      },
      inspect: async (cwd) => {
        const requests = z.array(z.object({ method: z.string(), path: z.string(), authorized: z.boolean() }))
          .parse(JSON.parse(await readFile(join(cwd, '.dsh/pathway-requests.json'), 'utf8')))
        expect(requests.map(request => request.path)).toEqual([
          '/runtime/pathway/pathway_read', '/runtime/pathway/history_query', '/runtime/pathway/case_read', '/runtime/pathway/case_read',
        ])
        expect(requests.every(request => request.method === 'POST' && request.authorized)).toBe(true)
        const sessions = join(cwd, '.dsh/sessions')
        const paths = await readdir(sessions, { recursive: true })
        const logs = await Promise.all(paths.filter(path => /session\.v[0-9]+\.jsonl$/.test(path)).map(path => readFile(join(sessions, path), 'utf8')))
        const text = logs.join('\n')
        for (const evidence of ['pathway_read', 'history_query', 'case_read', 'synthetic-pathway', 'admissionCount', '合成病程：已记录复评计划。',
          'Synthetic encounter is outside the authorized scope.', '"isError":true', '参考分析（未写入临床系统）']) expect(text).toContain(evidence)
        expect(text).not.toContain('synthetic-pathway-runtime-token')
        expect(text).not.toContain('databaseConfigFile')
      },
    })
    expect(output.stdout).toContain('未创建业务草案、修改路径或发布版本')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
