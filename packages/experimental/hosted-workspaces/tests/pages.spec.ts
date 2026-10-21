/** Browser-facing account pages keep localization, logout semantics, and identity labels safe. */
import { JSDOM } from 'jsdom'
import { createHash } from 'node:crypto'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { escapeHtml, implicitCallbackPage, page, withLogout } from '../src/pages.ts'

function document(html: string): Document {
  const dom = new JSDOM(html)
  onTestFinished(() => { dom.window.close() })
  return dom.window.document
}

describe('hosted account pages', () => {
  it.each([
    [undefined, 'Verifying company sign in…'],
    ['zh-CN', '正在验证公司登录……'],
  ])('clears implicit tokens before same-origin form submission and pins the exact script (%s)', (locale, pending) => {
    const bridge = implicitCallbackPage(locale)
    const dom = new JSDOM(bridge.html, { url: 'http://chat.localhost:8080/auth/callback#id_token=sensitive&state=bound&submit=clobber', runScripts: 'outside-only' })
    onTestFinished(() => { dom.window.close() })
    let submittedUrl: string | undefined
    const submit = vi.spyOn(dom.window.HTMLFormElement.prototype, 'submit').mockImplementation(() => { submittedUrl = dom.window.location.href })
    onTestFinished(() => { submit.mockRestore() })
    const script = dom.window.document.querySelector('script')?.textContent ?? ''
    expect(createHash('sha256').update(script).digest('base64')).toBe(bridge.scriptHash)
    dom.window.eval(script)
    const submitted = dom.window.document.querySelector('form')
    expect(submit).toHaveBeenCalledOnce()
    expect(submittedUrl).toBe('http://chat.localhost:8080/auth/callback')
    expect(submitted?.action).toBe('http://chat.localhost:8080/auth/callback')
    expect(submitted?.method).toBe('post')
    expect(submitted?.querySelector('input[name="id_token"]')?.getAttribute('value')).toBe('sensitive')
    expect(dom.window.document.querySelector('#notice')?.textContent).toBe(pending)
    expect(dom.window.localStorage.length).toBe(0)
    expect(dom.window.sessionStorage.length).toBe(0)
    expect(bridge.html).not.toContain('sensitive')
  })

  it('leaves a localized retry action without submitting an absent or unbound fragment', () => {
    for (const fragment of ['', '#id_token=unbound']) {
      const dom = new JSDOM(implicitCallbackPage('zh-CN').html, { url: `http://chat.localhost:8080/auth/callback${fragment}`, runScripts: 'outside-only' })
      onTestFinished(() => { dom.window.close() })
      dom.window.eval(dom.window.document.querySelector('script')?.textContent ?? '')
      expect(dom.window.location.hash).toBe('')
      expect(dom.window.document.querySelector('form')).toBeNull()
      expect(dom.window.document.querySelector('#notice')?.textContent).toContain('工作区请求失败')
      expect(dom.window.document.querySelector('a')?.textContent).toBe('返回入口')
    }
  })

  it.each([
    [undefined, 'en', 'Company sign in'],
    ['en-US', 'en', 'Company sign in'],
    ['ZH-cn,en;q=0.8', 'zh-CN', '公司账号登录'],
  ])('renders a localized entry with the gateway login action (%s)', (locale, language, action) => {
    const result = document(page(locale, 'entry', 'https://chat.example.test'))
    expect(result.documentElement.lang).toBe(language)
    expect(result.querySelector('a')?.getAttribute('href')).toBe('/auth/login')
    expect(result.querySelector('a')?.textContent).toBe(action)
    expect(result.querySelector('form')).toBeNull()
  })

  it.each([
    ['en-US', 'The workspace request failed.'],
    ['zh-CN', '工作区请求失败。'],
  ])('returns a localized failure to the configured portal (%s)', (locale, message) => {
    const result = document(page(locale, 'failure', 'https://chat.example.test'))
    expect(result.body.textContent).toContain(message)
    expect(result.querySelector('a')?.getAttribute('href')).toBe('https://chat.example.test')
  })

  it.each([
    ['en-US', 'Background tasks and private files are retained.', 'Company sign in'],
    ['zh-CN', '后台任务和私有文件予以保留。', '公司账号登录'],
  ])('states retained-work semantics after application logout (%s)', (locale, message, action) => {
    const result = document(page(locale, 'signedOut', 'https://chat.example.test'))
    expect(result.body.textContent).toContain(message)
    expect(result.querySelector('a')?.getAttribute('href')).toBe('/auth/login')
    expect(result.querySelector('a')?.textContent).toBe(action)
  })

  it.each([
    ['en-US', 'Opening your private workspace…', 'Continue to workspace'],
    ['zh-CN', '正在进入你的个人工作区……', '进入工作区'],
  ])('starts a fresh private-origin navigation with a localized continue link (%s)', (locale, message, action) => {
    const result = document(page(locale, 'handoff', 'https://chat.example.test'))
    expect(result.querySelector('meta[http-equiv="refresh"]')?.getAttribute('content')).toBe('0;url=/')
    expect(result.querySelector('a')?.getAttribute('href')).toBe('/')
    expect(result.querySelector('a')?.textContent).toBe(action)
    expect(result.body.textContent).toContain(message)
    expect(result.querySelector('script')).toBeNull()
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
