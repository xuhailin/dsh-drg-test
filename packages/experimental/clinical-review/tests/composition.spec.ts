import { readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { z } from 'zod'
import { snapshotSchema } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { reportSchema } from '../src/projection.ts'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const fixture = fileURLToPath(new URL('./snapshot-fixture.ts', import.meta.url))

describe('clinical review through the shipped headless profile', () => {
  it('repairs an unread-source proposal through real evidence tools and saves a cited report without a discharge decision', async () => {
    const patchName = 'clinical-review.patch.yml'
    const output = await runLoaderSmoke({ label: 'clinical-review', tempDirPrefix: 'dsh-clinical-composition-',
      binScript: join(root, 'apps/cli/src/bin.ts'), tsconfigPath: join(root, 'tsconfig.json'), sourceImport: 'tsx/esm', configPath: patchName,
      binArgs: ['--profile', 'headless', '--patch', patchName, '--json', '核查当前合成病例的出院文书，列出有原文依据的问题。'],
      env: { DEEPSEEK_API_KEY: undefined },
      prepare: async (cwd) => {
        await writeFile(join(cwd, patchName), [
          '- id: llm-deepseek', '  disabled: true', '- id: session-title-llm', '  disabled: true',
          '- id: agent-instructions', '  disabled: true', '- id: plan-mode', '  disabled: true',
          '- id: agent-default-model', '  config:', '    provider: clinical-fixture', '    model: fixture',
          '- id: session-persistence-jsonl', '  config:', "    root: !!js dshHomePath('sessions')", '    compression: none',
          '- insert:', '    - id: clinical-review-fixture', `      name: ${JSON.stringify(fixture)}`, '      config:', '        scriptModel: true', '        saveResult: true', '',
        ].join('\n'))
      },
      inspect: async (cwd) => {
        const sessions = join(cwd, '.dsh/sessions')
        const paths = await readdir(sessions, { recursive: true })
        const logs = await Promise.all(paths.filter(path => /session\.v[0-9]+\.jsonl$/.test(path)).map(path => readFile(join(sessions, path), 'utf8')))
        const text = logs.join('\n')
        expect(text).toContain('你是“医保助手”，面向临床医生')
        expect(text).toContain('"name":"web_search"')
        expect(text).toContain('"name":"read"')
        expect(text).toContain('review_read_evidence')
        expect(text).toContain('review_submit_findings')
        expect(text).toContain('pending-human-review')
        expect(text).toContain('肺炎描述不一致')
        expect(text).toContain('"isError":true')
        expect(text).toContain('Source synthetic-document-1 at reviewedSourceRefs[0] has not been fully read.')
        expect(text).toContain('"drg":"unavailable"')
        expect(text).toContain('"dip":"unavailable"')
        const saved = z.object({ reports: z.array(z.object({ report: reportSchema, snapshot: snapshotSchema.nullable(),
          generatedAt: z.string().nullable() })) }).parse(JSON.parse(await readFile(join(cwd, '.dsh/clinical-saved-result.json'), 'utf8')))
        expect(saved.reports).toHaveLength(1)
        expect(saved.reports[0]?.report).toMatchObject({ assessment: 'pending-human-review', findings: [{ kind: 'inconsistency',
          citations: [{ quote: 'pneumonia' }, { quote: 'no pneumonia' }] }], reviewedSourceRefs: ['synthetic-document-1'] })
        expect(saved.reports[0]?.snapshot?.sources[0]?.content).toContain('Clinical diagnosis: pneumonia.')
        expect(typeof saved.reports[0]?.generatedAt).toBe('string')
      },
    })
    expect(output.stdout).toContain('不影响出院')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
