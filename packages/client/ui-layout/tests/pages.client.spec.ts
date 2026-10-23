/** Standalone route selection and unload behavior without Session navigation. */
import { describe, expect, it } from 'vitest'
import { PageRegistry } from '../src/client/pages.ts'

describe('standalone pages', () => {
  it('selects a page independently of other query references and re-evaluates navigation', () => {
    let search = '?page=results&sessionId=one'
    const pages = new PageRegistry(() => search)
    const dispose = pages.register({ page: 'results', key: 'report' })
    expect(pages.selection.getSnapshot()).toBe('report')
    search = '?page=results-other'
    pages.refresh()
    expect(pages.selection.getSnapshot()).toBeNull()
    search = '?page=results&revision=2'
    pages.refresh()
    expect(pages.selection.getSnapshot()).toBe('report')
    dispose()
    dispose()
    expect(pages.selection.getSnapshot()).toBeNull()
  })

  it('rejects collisions and unsupported page selectors', () => {
    const pages = new PageRegistry(() => '?page=results')
    for (const page of ['', '/', 'https://example.com', 'results?secret=x', 'results#fragment']) {
      expect(() => pages.register({ page, key: 'report' })).toThrow()
    }
    expect(() => pages.register({ page: 'results', key: '' })).toThrow()
    const dispose = pages.register({ page: 'results', key: 'report' })
    expect(() => pages.register({ page: 'results', key: 'other' })).toThrow('already owns')
    expect(pages.selection.getSnapshot()).toBe('report')
    dispose()
    pages.register({ page: 'results', key: 'replacement' })
    expect(pages.selection.getSnapshot()).toBe('replacement')
  })
})
