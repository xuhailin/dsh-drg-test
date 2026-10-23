/** Browser-facing account pages keep localization, logout semantics, and identity labels safe. */
import { JSDOM } from 'jsdom'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { escapeHtml, implicitCallbackPage, page, withLogout } from '../src/pages.ts'

function document(html: string): Document {
  const dom = new JSDOM(html)
  onTestFinished(() => { dom.window.close() })
  return dom.window.document
}

function callback(locale: string | undefined, fragment: string, signedIn = false) {
  const bridge = implicitCallbackPage(locale, signedIn)
  const dom = new JSDOM(bridge.html, { url: `http://chat.localhost:8080/auth/callback${fragment}`, runScripts: 'outside-only' })
  onTestFinished(() => { dom.window.close() })
  let submittedUrl: string | undefined
  const submit = vi.spyOn(dom.window.HTMLFormElement.prototype, 'submit').mockImplementation(() => { submittedUrl = dom.window.location.href })
  onTestFinished(() => { submit.mockRestore() })
  const script = dom.window.document.querySelector('script')?.textContent ?? ''
  return { bridge, dom, script, submit, submittedUrl: () => submittedUrl }
}

describe('hosted account pages', () => {
  it.each([
    [undefined, 'Verifying sign-in…'],
    ['zh-CN', '正在验证登录……'],
  ])('shows pending verification before posting the fragment and pins the exact script (%s)', (locale, pending) => {
    const world = callback(locale, '#id_token=sensitive&state=bound&submit=clobber&appendChild=clobber')
    const result = world.dom.window.document
    expect(result.querySelector('#notice')?.textContent).toBe(pending)
    expect(result.querySelector('#callback-status')?.getAttribute('aria-busy')).toBe('true')
    expect(result.querySelector<HTMLAnchorElement>('#retry')?.hidden).toBe(true)
    expect(createHash('sha256').update(world.script).digest('base64')).toBe(world.bridge.scriptHash)
    world.dom.window.eval(world.script)
    const submitted = result.querySelector('form')
    expect(world.submit).toHaveBeenCalledOnce()
    expect(world.submittedUrl()).toBe('http://chat.localhost:8080/auth/callback')
    expect(submitted?.action).toBe('http://chat.localhost:8080/auth/callback')
    expect(submitted?.method).toBe('post')
    expect(submitted?.querySelector('input[name="id_token"]')?.getAttribute('value')).toBe('sensitive')
    expect(submitted?.querySelector('input[name="appendChild"]')?.getAttribute('value')).toBe('clobber')
    expect(result.querySelector('#notice')?.textContent).toBe(pending)
    expect(result.querySelector<HTMLAnchorElement>('#retry')?.hidden).toBe(true)
    expect(world.dom.window.localStorage.length).toBe(0)
    expect(world.dom.window.sessionStorage.length).toBe(0)
    expect(world.bridge.html).not.toContain('sensitive')
  })

  it.each(['', '#id_token=unbound', '#state=&id_token=unbound'])('shows a sign-in recovery action without submitting an unbound fragment (%s)', (fragment) => {
    const world = callback('zh-CN', fragment)
    world.dom.window.eval(world.script)
    const result = world.dom.window.document
    expect(world.dom.window.location.hash).toBe('')
    expect(world.submit).not.toHaveBeenCalled()
    expect(result.querySelector('form')).toBeNull()
    expect(result.querySelector('#notice')?.textContent).toBe('登录未完成')
    expect(result.querySelector('#detail')?.textContent).toBe('请重新登录后继续')
    expect(result.querySelector('#callback-status')?.getAttribute('aria-busy')).toBe('false')
    expect(result.querySelector<HTMLElement>('#spinner')?.hidden).toBe(true)
    expect(result.querySelector<HTMLAnchorElement>('#retry')?.hidden).toBe(false)
    expect(result.querySelector('#retry')?.textContent).toBe('重新登录')
    expect(result.querySelector('#retry')?.getAttribute('href')).toBe('/')
  })

  it.each(['', '#'])('resumes a signed-in empty callback through the portal after clearing its fragment (%s)', (fragment) => {
    const world = callback('zh-CN', fragment, true)
    const events: string[] = []
    const location = {
      hash: fragment, pathname: '/auth/callback',
      replace: vi.fn((target: string) => { events.push(`resume:${target}`) }),
    }
    const history = { replaceState: vi.fn(() => { location.hash = ''; events.push('clear') }) }
    runInNewContext(world.script, { location, history, document: world.dom.window.document, URLSearchParams })
    expect(events).toEqual(['clear', 'resume:/'])
    expect(location.replace).toHaveBeenCalledOnce()
    expect(location.replace).toHaveBeenCalledWith('/')
    expect(world.submit).not.toHaveBeenCalled()
    expect(world.dom.window.document.querySelector('form')).toBeNull()
    expect(world.dom.window.document.querySelector('#callback-status')?.getAttribute('data-signed-in')).toBe('true')
    expect(implicitCallbackPage('zh-CN').scriptHash).toBe(world.bridge.scriptHash)
  })

  it.each(['#id_token=unbound', '#state=', '#state=&id_token=unbound', '#error=invalid_request'])('does not treat an unbound SSO response as a signed-in refresh (%s)', (fragment) => {
    const world = callback('zh-CN', fragment, true)
    world.dom.window.eval(world.script)
    expect(world.dom.window.location.hash).toBe('')
    expect(world.submit).not.toHaveBeenCalled()
    expect(world.dom.window.document.querySelector('#notice')?.textContent).toBe('登录未完成')
    expect(world.dom.window.document.querySelector<HTMLAnchorElement>('#retry')?.hidden).toBe(false)
  })

  it('posts a new identity response even when the server has an existing signed-in session', () => {
    const world = callback('zh-CN', '#state=new-login&id_token=new-identity', true)
    world.dom.window.eval(world.script)
    expect(world.submit).toHaveBeenCalledOnce()
    expect(world.submittedUrl()).toBe('http://chat.localhost:8080/auth/callback')
    expect(world.dom.window.document.querySelector('form input[name="id_token"]')?.getAttribute('value')).toBe('new-identity')
    expect(world.dom.window.document.querySelector('#callback-status')?.getAttribute('aria-busy')).toBe('true')
  })

  it('uses English sign-in recovery without a language header', () => {
    const world = callback(undefined, '')
    world.dom.window.eval(world.script)
    expect(world.dom.window.document.querySelector('#notice')?.textContent).toBe('Sign-in incomplete')
    expect(world.dom.window.document.querySelector('#retry')?.textContent).toBe('Sign in again')
  })

  it.each([
    [undefined, 'Enable JavaScript to finish signing in, then sign in again.', 'Sign in again'],
    ['zh-CN', '请启用 JavaScript 后重新登录，以完成身份验证', '重新登录'],
  ])('provides a visible recovery path when scripts cannot run (%s)', (locale, detail, action) => {
    const result = document(implicitCallbackPage(locale).html)
    expect(result.defaultView?.getComputedStyle(result.querySelector('#callback-status')!).display).toBe('none')
    expect(result.querySelector('noscript p')?.textContent).toBe(detail)
    expect(result.querySelector('noscript a')?.textContent).toBe(action)
    expect(result.querySelector('noscript a')?.getAttribute('href')).toBe('/')
    expect(result.querySelector('form')).toBeNull()
  })

  it.each([
    [undefined, 'en', 'Company sign in'],
    ['en-US', 'en', 'Company sign in'],
    ['ZH-cn,en;q=0.8', 'zh-CN', '公司账号登录'],
  ])('renders a localized entry with the gateway login action (%s)', (locale, language, action) => {
    const result = document(page(locale, 'entry', 'https://chat.example.test'))
    expect(result.documentElement.lang).toBe(language)
    expect(result.querySelector('header')?.textContent).toBe('DRG Agent')
    expect(result.querySelector('title')?.textContent).toContain('DRG Agent')
    expect(result.querySelector('a')?.getAttribute('href')).toBe('/auth/login')
    expect(result.querySelector('a')?.textContent).toBe(action)
    expect(result.querySelector('form')).toBeNull()
  })

  it.each([
    ['en-US', 'Unable to continue'],
    ['zh-CN', '暂时无法继续'],
  ])('returns a localized fallback failure to the configured entry (%s)', (locale, message) => {
    const result = document(page(locale, 'failure', 'https://chat.example.test'))
    expect(result.querySelector('h1')?.textContent).toBe(message)
    expect(result.querySelector('a')?.getAttribute('href')).toBe('https://chat.example.test')
  })

  it.each([
    ['en-US', 'loginFailure', 'Sign-in incomplete', 'Sign in again'],
    ['zh-CN', 'loginFailure', '登录未完成', '重新登录'],
    ['en-US', 'workspaceFailure', 'Workspace temporarily unavailable', 'Try again'],
    ['zh-CN', 'workspaceFailure', '暂时无法打开工作区', '重试'],
  ] as const)('distinguishes the failed operation and recovers through its owning origin (%s, %s)', (locale, state, message, action) => {
    const entry = 'https://u-123.chat.example.test/?a=1&b=2'
    const result = document(page(locale, state, entry))
    expect(result.querySelector('h1')?.textContent).toBe(message)
    expect(result.querySelector('a')?.textContent).toBe(action)
    expect(result.querySelector('a')?.getAttribute('href')).toBe(entry)
    expect(result.querySelector('script')).toBeNull()
    expect(result.querySelector('meta[http-equiv="refresh"]')).toBeNull()
  })

  it.each([
    ['en-US', 'Background tasks and private files are retained.', 'Company sign in'],
    ['zh-CN', '后台任务和私有文件予以保留', '公司账号登录'],
  ])('states retained-work semantics after application logout (%s)', (locale, message, action) => {
    const result = document(page(locale, 'signedOut', 'https://chat.example.test'))
    expect(result.body.textContent).toContain(message)
    expect(result.querySelector('a')?.getAttribute('href')).toBe('/auth/login')
    expect(result.querySelector('a')?.textContent).toBe(action)
  })

  it.each([
    ['en-US', 'Opening your workspace…', 'Continue to workspace'],
    ['zh-CN', '正在打开工作区……', '进入工作区'],
  ])('starts a fresh private-origin navigation with a localized continue link (%s)', (locale, message, action) => {
    const result = document(page(locale, 'handoff', 'https://chat.example.test'))
    expect(result.querySelector('meta[http-equiv="refresh"]')?.getAttribute('content')).toBe('0;url=/')
    expect(result.querySelector('a')?.getAttribute('href')).toBe('/')
    expect(result.querySelector('a')?.textContent).toBe(action)
    expect(result.body.textContent).toContain(message)
    expect(result.querySelector('script')).toBeNull()
  })

  it('retains the server-created handoff target in automatic and manual navigation', () => {
    const target = 'https://u-123.chat.example.test/auth/handoff?ticket=one-use&return=1'
    const result = document(page('en-US', 'handoff', 'https://chat.example.test', target))
    expect(result.querySelector('meta[http-equiv="refresh"]')?.getAttribute('content')).toBe(`0;url=${target}`)
    expect(result.querySelector('a')?.getAttribute('href')).toBe(target)
  })

  it('keeps standalone status pages self-contained with keyboard, theme, and motion support', () => {
    const result = document(page('en-US', 'workspaceFailure', 'https://chat.example.test'))
    expect(result.querySelector('script[src],link[href],img[src],[onclick],[onload]')).toBeNull()
    const css = result.querySelector('style')?.textContent ?? ''
    expect(css).toContain('a:focus-visible')
    expect(css).toContain('prefers-color-scheme:dark')
    expect(css).toContain('prefers-reduced-motion:reduce')
    expect(css).toContain('@media(hover:hover)')
    expect(result.body.textContent).not.toContain('个人 DSH 工作区')
  })

  it('preserves the actual document while inserting a POST logout control with an escaped identity label', () => {
    const name = '<img src=x onerror="bad()"> & \'Doctor\''
    const result = document(withLogout('<!doctype html><html><BODY class="chat"><main>Conversation</main></BODY></html>', name, 'zh-CN'))
    expect(result.querySelector('main')?.textContent).toBe('Conversation')
    expect(result.body.className).toBe('chat')
    const form = result.querySelector('form')
    expect(form?.getAttribute('method')).toBe('post')
    expect(form?.getAttribute('action')).toBe('/auth/logout')
    expect(form?.querySelector('span')?.textContent).toBe(name)
    expect(form?.querySelector('span')?.getAttribute('title')).toBe(name)
    expect(form?.querySelector('button')?.textContent).toBe('退出登录')
    expect(form?.querySelector('img')).toBeNull()
  })

  it('reserves an account row without covering workspace controls and truncates a long label', () => {
    const name = 'Doctor '.repeat(80)
    const result = document(withLogout('<html><body><div id="root">Workspace controls</div></body></html>', name, 'en-US'))
    const view = result.defaultView
    const form = result.querySelector('form')
    const label = form?.querySelector('span')
    const root = result.querySelector('#root')
    if (view === null || form === null || label === undefined || label === null || root === null) throw new Error('missing account document')
    expect(view.getComputedStyle(result.body).display).toBe('grid')
    expect(view.getComputedStyle(result.body).gridTemplateRows).toBe('auto minmax(0,1fr)')
    expect(view.getComputedStyle(root).gridRow).toBe('2')
    expect(view.getComputedStyle(root).minHeight).toBe('0px')
    expect(view.getComputedStyle(root).minWidth).toBe('0px')
    expect(view.getComputedStyle(form).position).not.toBe('fixed')
    expect(view.getComputedStyle(form).gridRow).toBe('1')
    expect(view.getComputedStyle(form).margin).toBe('0px')
    expect(view.getComputedStyle(label).textOverflow).toBe('ellipsis')
    expect(view.getComputedStyle(label).minWidth).toBe('0px')
    expect(label.textContent).toBe(name)
    expect(label.getAttribute('title')).toBe(name)
  })

  it('defaults the logout control to English without a language header', () => {
    const result = document(withLogout('<html><body>Chat</body></html>', 'Doctor', undefined))
    expect(result.querySelector('button')?.textContent).toBe('Sign out')
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
  })
})
