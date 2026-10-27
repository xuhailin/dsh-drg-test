import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const fixture = fileURLToPath(new URL('./snapshot-fixture.ts', import.meta.url))
const scenario = join(root, 'snapshots/session/clinical-pathway-reference')

describe('pathway reference through production Loader composition', () => {
  it('creates, reads, commits, undoes and restores the same private reference through real Agent tools', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-pathway-reference-composition-'))
    try {
      const patchName = 'reference.patch.yml'
      const source = (await readFile(join(scenario, 'cordis.yml'), 'utf8'))
        .replace('name: ../../../packages/experimental/clinical-pathway-reference/tests/snapshot-fixture.ts', `name: ${JSON.stringify(fixture)}`)
        .replace('scriptModel: false', 'scriptModel: true')
        + '\n- id: llm-deepseek\n  disabled: true\n- id: session-title-llm\n  disabled: true\n- id: plugin-package-inventory-deepseek\n  disabled: true\n'
      const launch = (restore: boolean) => runLoaderSmoke({ label: 'clinical-pathway-reference', cwd,
        binScript: join(root, 'apps/cli/src/bin.ts'), tsconfigPath: join(root, 'tsconfig.json'), sourceImport: 'tsx/esm', configPath: patchName,
        binArgs: ['--profile', 'headless', '--patch', patchName, restore ? '核对已保存参考稿的恢复。' : '建立合成参考稿，修改名称后撤回并查看保存内容；不写入医院。'],
        env: { DEEPSEEK_API_KEY: undefined, REFERENCE_FIXTURE_TOKEN: 'synthetic-reference-read-token', TZ: 'UTC', DSH_PERMISSION_MODE: 'danger-full-access' },
        prepare: async () => { await writeFile(join(cwd, patchName), restore ? source.replace('restore: false', 'restore: true') : source) },
      })
      const first = await launch(false)
      expect(first.stdout).toContain('参考稿已保存')
      const paths = await readdir(join(cwd, '.dsh/sessions'), { recursive: true })
      const logs = await Promise.all(paths.filter(path => /session\.v[0-9]+\.jsonl$/.test(path)).map(path => readFile(join(cwd, '.dsh/sessions', path), 'utf8')))
      expect(logs).toHaveLength(1)
      const log = logs[0]!
      for (const value of ['pathway_reference', 'plugin:clinical-pathway-reference/state', 'synthetic-create', 'synthetic-commit', 'synthetic-undo', '合成 AI 修改后路径', 'source:item:301']) expect(log).toContain(value)
      expect(log).not.toContain('synthetic-reference-read-token')
      const restored = await launch(true)
      expect(restored.stdout).toContain('参考稿已从持久化 Session 恢复')
    } finally { await rm(cwd, { recursive: true, force: true }) }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS * 2)
})
