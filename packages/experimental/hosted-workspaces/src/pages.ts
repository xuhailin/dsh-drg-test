/** Localized gateway pages and the authenticated workspace logout control. */

const copy = {
  en: { title: 'Private DSH workspace', intro: 'Sign in with your company account to open your private workspace.', login: 'Company sign in', logout: 'Sign out', failure: 'The workspace request failed. Return to the entry page and try again.', signedOut: 'Signed out. Background tasks and private files are retained.', retry: 'Return to entry', handoff: 'Opening your private workspace…', continue: 'Continue to workspace' },
  zh: { title: '个人 DSH 工作区', intro: '使用公司账号登录，进入自己的聊天与工具工作区。', login: '公司账号登录', logout: '退出登录', failure: '工作区请求失败。请返回入口后重试。', signedOut: '已退出登录。后台任务和私有文件予以保留。', retry: '返回入口', handoff: '正在进入你的个人工作区……', continue: '进入工作区' },
} as const

/**
 * Escape a plain label before HTML interpolation.
 * @param value - plain text, including identity-provider display labels.
 * @returns HTML-safe text.
 */
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/**
 * Render a self-contained account page; handoff starts a fresh private-origin navigation.
 * @param locale - browser language header.
 * @param state - page purpose.
 * @param entry - validated public gateway origin.
 * @returns complete document.
 */
export function page(locale: string | undefined, state: 'entry' | 'failure' | 'signedOut' | 'handoff', entry: string): string {
  const c = locale?.toLowerCase().includes('zh') ? copy.zh : copy.en
  const signIn = state === 'entry' || state === 'signedOut'
  const link = signIn ? '/auth/login' : state === 'handoff' ? '/' : entry
  const refresh = state === 'handoff' ? '<meta http-equiv="refresh" content="0;url=/">' : ''
  return `<!doctype html><html lang="${c === copy.zh ? 'zh-CN' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh}<title>${c.title}</title><style>body{font:16px system-ui;background:#f7f8fa;color:#17202a;margin:0;display:grid;min-height:100vh;place-items:center}main{max-width:420px;padding:40px;border:1px solid #e0e4ea;border-radius:16px;background:white}h1{font-size:25px}p{line-height:1.7;color:#52606d}a{display:inline-block;background:#255de5;color:white;padding:12px 18px;border-radius:8px;text-decoration:none}</style><main><h1>${c.title}</h1><p>${c[state === 'entry' ? 'intro' : state === 'handoff' ? 'handoff' : state === 'failure' ? 'failure' : 'signedOut']}</p><a href="${escapeHtml(link)}">${signIn ? c.login : state === 'handoff' ? c.continue : c.retry}</a></main></html>`
}

/**
 * Add a server-owned logout form to the real DSH document.
 * @param html - authenticated DSH index.
 * @param name - verified display label.
 * @param locale - browser language header.
 * @returns the document with a reserved account row above the application mount.
 */
export function withLogout(html: string, name: string, locale: string | undefined): string {
  const c = locale?.toLowerCase().includes('zh') ? copy.zh : copy.en
  const style = '<style>body{display:grid;grid-template-rows:auto minmax(0,1fr)}body>#root{grid-row:2;min-height:0;min-width:0}.dsh-hosted-account{grid-row:1;margin:0;min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:4px 12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border-bottom:0.5px solid var(--dsw-alias-border-l3);font-size:12px;line-height:18px}.dsh-hosted-account span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-hosted-account button{flex:none;height:28px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);color:inherit;background:transparent;font:inherit;cursor:pointer}</style>'
  const form = `<form class="dsh-hosted-account" method="post" action="/auth/logout"><span title="${escapeHtml(name)}">${escapeHtml(name)}</span><button type="submit">${c.logout}</button></form>`
  return html.replace(/<body(?:\s[^>]*)?>/iu, body => body + style + form)
}
