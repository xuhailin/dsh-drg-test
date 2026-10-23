// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { ThemeRuntime, type ThemeSettings } from '@deepseek-ai/dsh-client-ui-theme/client'
import * as plugin from '../src/client/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
})

function bench() {
  const ctx = new Context()
  contexts.push(ctx)
  const host = stubConfigForm<ThemeSettings>()
  const theme = new ThemeRuntime(ctx, host.scope)
  ctx.provide('theme', theme)
  return { ctx, theme, host }
}

describe('Synyi theme layer', () => {
  it('keeps standard preferences and restores earlier tokens when unloaded', async () => {
    const { ctx, theme, host } = bench()
    const previous = theme.overrideTokens('previous', {
      '--dsw-alias-brand-primary': { light: 'green', dark: 'lime' },
    })
    const fiber = ctx.plugin(plugin)
    await fiber.await()
    expect(theme.getTheme().preference).toBe('system')
    expect(theme.getTheme().active.tokens).toMatchObject({
      '--dsw-alias-bg-base': '#f0f2f5',
      '--dsw-alias-brand-primary': '#3664d9',
      '--dsw-alias-label-primary': '#293750',
      '--dsw-radius-md': '4px',
      '--dsw-radius-panel': '8px',
      '--dsw-linear-gradient-think': 'linear-gradient(180deg, var(--dsw-alias-bg-base) 20.19%, transparent 100%)',
    })
    expect(host.set).not.toHaveBeenCalled()
    theme.setTheme('dark')
    expect(theme.getTheme().active.tokens).toMatchObject({
      '--dsw-alias-bg-base': '#151e2c',
      '--dsw-alias-brand-primary': '#9cb6ff',
      '--dsw-alias-label-primary': '#e6ecf5',
      '--dsw-menu-surface-fill': 'rgba(36, 51, 75, 0.96)',
      '--dsw-radius-panel': '8px',
    })
    await fiber.dispose()
    expect(theme.getTheme().preference).toBe('dark')
    expect(theme.getTheme().active.tokens).toEqual({ '--dsw-alias-brand-primary': 'lime' })
    previous()
    expect(theme.getTheme().active.tokens).toEqual({})
  })

  it('follows OS palette changes while the standard preference is system', async () => {
    let notify = (): void => {}
    const media = {
      matches: false,
      addEventListener: (_event: string, listener: () => void) => { notify = listener },
      removeEventListener: vi.fn(),
    }
    vi.stubGlobal('matchMedia', () => media)
    const { ctx, theme } = bench()
    const fiber = ctx.plugin(plugin)
    await fiber.await()
    expect(theme.getTheme().active.tokens['--dsw-alias-bg-base']).toBe('#f0f2f5')
    media.matches = true
    notify()
    expect(theme.getTheme().preference).toBe('system')
    expect(theme.getTheme().active.tokens['--dsw-alias-bg-base']).toBe('#151e2c')
    await fiber.dispose()
    expect(theme.getTheme().active.tokens).toEqual({})
  })
})
