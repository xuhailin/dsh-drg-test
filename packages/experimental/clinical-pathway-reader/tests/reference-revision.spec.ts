import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const fixture = fileURLToPath(new URL('./reference-revision-fixture.ts', import.meta.url))

describe('reference revisions and persisted-session reopening', () => {
  it('retains user edits, unchanged evidence and distinct targets after the CLI exits and a fresh JSONL provider restores the Session', async () => {
    await runLoaderSmoke({ label: 'pathway-reference-revision', tempDirPrefix: 'dsh-pathway-reference-',
      binScript: join(root, 'apps/cli/src/bin.ts'), tsconfigPath: join(root, 'tsconfig.json'), sourceImport: 'tsx/esm', configPath: 'revision.patch.yml',
      binArgs: ['--profile', 'headless', '--patch', 'revision.patch.yml', '--json',
        '参考路径 101 和病例 123，生成合成新路径参考稿 v1，保存 reference-v1.md；仅供讨论，不创建医院业务草案。'],
      env: { DEEPSEEK_API_KEY: undefined, PATHWAY_FIXTURE_TOKEN: 'synthetic-pathway-runtime-token', TZ: 'UTC' },
      prepare: async (cwd) => {
        const original = await readFile(join(root, 'snapshots/session/clinical-pathway-reader/cordis.yml'), 'utf8')
        const patch = original
          .replace('name: ../../../packages/experimental/clinical-pathway-reader/tests/snapshot-fixture.ts', `name: ${JSON.stringify(fixture)}`)
          .replace('provider: pathway-fixture', 'provider: pathway-revision-fixture')
          + ['- id: llm-deepseek', '  disabled: true', '- id: session-title-llm', '  disabled: true',
            '- id: session-persistence-jsonl', '  config:', "    root: !!js dshHomePath('sessions')", '    compression: none', ''].join('\n')
        await writeFile(join(cwd, 'revision.patch.yml'), patch)
      },
      inspect: async (cwd) => {
        const first = await readFile(join(cwd, 'reference-v1.md'), 'utf8')
        const second = await readFile(join(cwd, 'reference-v2.md'), 'utf8')
        const switched = await readFile(join(cwd, 'target-202.md'), 'utf8')
        expect(first).toContain('项目：核对复评计划。')
        expect(first).not.toContain('由临床负责人复核复评计划')
        expect(second).toContain('项目：由临床负责人复核复评计划。')
        expect(second).toContain('v1“核对复评计划”→v2“由临床负责人复核复评计划”')
        for (const unchanged of ['阶段：复评阶段。', '引用：documents:10:20，2025-10-20，合成病程：已记录复评计划。', '缺口：实际执行、检验和检查尚未支持。']) {
          expect(first).toContain(unchanged)
          expect(second).toContain(unchanged)
        }
        expect(switched).toContain('目标：pathway:202／版本2，合成第二路径。')
        expect(switched).not.toContain('documents:10:20')

        // The originating CLI process has exited; this independent provider parses persisted generations and restores messages.
        const reopened = new Context()
        try {
          await reopened.plugin(JsonlPersistence, { root: join(cwd, '.dsh/sessions'), compression: 'none' })
          const entries = await reopened.sessionPersistence.list()
          expect(entries).toHaveLength(1)
          const entry = entries[0]
          if (entry === undefined) throw new Error('Saved reference Session is missing')
          const handle = await reopened.sessionPersistence.open(entry.header.id, 'read')
          try {
            const saved = await handle.read()
            const session = Session.fromRestore(entry.header.id, saved.events, handle.header, handle.inheritedEventCount, saved.eventState)
            const messages = session.deriveMessages()
            const text = JSON.stringify(messages)
            expect(saved.events.filter(event => event.type === 'turn/end')).toHaveLength(3)
            expect(saved.events.filter(event => event.type === 'tool/result' && event.data.message.isError)).toEqual([])
            expect(text).toContain('请只把参考稿项目')
            expect(text).toContain('阶段、引用和资料缺口保持不变')
            expect(text).toContain('参考稿 v2 已保存')
            expect(text).toContain('documents:10:20')
            expect(text).toContain('现在切换到另一目标 pathwayId 202')
            expect(text).toContain('synthetic-other-pathway')
            const calls = saved.events.filter(event => event.type === 'tool/call' && event.data.name === 'pathway_read')
            expect(calls.map(event => event.type === 'tool/call'
              ? z.object({ pathwayId: z.string() }).parse(JSON.parse(event.data.arguments)) : null)).toEqual([{ pathwayId: '101' }, { pathwayId: '202' }])
          } finally { await handle.close() }
        } finally { await reopened.fiber.dispose() }
        const requests = z.array(z.object({ path: z.string(), args: z.record(z.string(), z.json()) }))
          .parse(JSON.parse(await readFile(join(cwd, '.dsh/pathway-requests.json'), 'utf8')))
        expect(requests.map(request => request.path)).toEqual(['/runtime/pathway/pathway_read', '/runtime/pathway/case_read', '/runtime/pathway/pathway_read'])
        expect(requests.filter(request => request.path.endsWith('pathway_read')).map(request => request.args.pathwayId)).toEqual(['101', '202'])
      },
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
