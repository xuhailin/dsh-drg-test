// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { SynyiBrandMark, SynyiBrandName } from '../src/client/Brand.tsx'
import { apply as hostApply } from '../src/index.ts'

const contexts: Context[] = []
const SIDEBAR_HOLES = ['sidebar.brand.mark', 'sidebar.brand.name'] as const
const HERO_HOLE = 'conversation.hero.brand.mark'
const HOLES = [...SIDEBAR_HOLES, HERO_HOLE] as const

afterEach(async () => {
  cleanup()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function bench(declare = true) {
  const ctx = new Context()
  contexts.push(ctx)
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declareHoles = () => slots.register({
    name: 'root',
    children: Object.fromEntries(HOLES.map(name => [name, { kind: 'single', scope: 'root' }])),
  } as never, () => null)
  const disposeHoles = declare ? declareHoles() : undefined
  return { ctx, slots, locale, declareHoles, disposeHoles }
}

describe('Synyi browser branding', () => {
  it('keeps the host entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('registers all declared brand surfaces and removes them with the plugin', async () => {
    const subject = await bench()
    const fiber = subject.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(1)
    subject.locale.setLocale('zh')
    expect(subject.locale.bind('synyiBrand')('brand.name')).toBe('森亿智能')

    subject.disposeHoles?.()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(0)
    subject.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(1)

    await fiber.dispose()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(0)
    expect(subject.locale.bind('synyiBrand')('brand.name')).toBe('brand.name')
  })

  it('waits for the declaring surfaces when it activates first', async () => {
    const subject = await bench(false)
    await subject.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(0)
    subject.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(1)
  })

  it('renders the supplied artwork at sidebar and welcome sizes with a localized name', async () => {
    const subject = await bench()
    await subject.ctx.plugin({ inject: [...inject], apply }).await()
    subject.locale.setLocale('en')
    const view = render(<SynyiBrandName t={subject.locale.bind('synyiBrand')} />)
    expect(view.getByText('SYNYI AI')).toBeTruthy()
    subject.locale.setLocale('zh')
    view.rerender(<SynyiBrandName t={subject.locale.bind('synyiBrand')} />)
    expect(view.getByText('森亿智能')).toBeTruthy()
    view.rerender(<SynyiBrandMark size={24} />)
    const mark = view.container.querySelector('img')
    expect(mark?.getAttribute('src')).toContain('synyi-mark.png')
    expect(mark?.getAttribute('width')).toBe('24')
    expect(mark?.getAttribute('alt')).toBe('')
    view.rerender(<SynyiBrandMark size={34} className="welcome-mark" />)
    expect(mark?.getAttribute('width')).toBe('34')
    expect(mark?.classList.contains('welcome-mark')).toBe(true)
  })
})
