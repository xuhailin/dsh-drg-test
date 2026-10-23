/** Localized gateway pages and authenticated workspace account metadata. */
import { createHash } from 'node:crypto'

type PageState = 'entry' | 'failure' | 'signedOut' | 'handoff' | 'loginFailure' | 'workspaceFailure'

interface ViewCopy {
  title: string
  detail: string
  action: string
}

interface PageCopy {
  language: string
  brand: string
  logout: string
  noScript: string
  views: Record<PageState | 'authenticating', ViewCopy>
}

const copy = {
  en: {
    language: 'en', brand: 'DRG Agent', logout: 'Sign out',
    noScript: 'Enable JavaScript to finish signing in, then sign in again.',
    views: {
      entry: { title: 'Continue to DRG Agent', detail: 'Use your company account to continue.', action: 'Company sign in' },
      failure: { title: 'Unable to continue', detail: 'Please try opening DRG Agent again.', action: 'Try again' },
      signedOut: { title: 'Signed out', detail: 'Background tasks and private files are retained.', action: 'Company sign in' },
      handoff: { title: 'Opening your workspace…', detail: 'You will continue automatically.', action: 'Continue to workspace' },
      loginFailure: { title: 'Sign-in incomplete', detail: 'Sign in again to continue.', action: 'Sign in again' },
      workspaceFailure: { title: 'Workspace temporarily unavailable', detail: 'Please try again in a moment.', action: 'Try again' },
      authenticating: { title: 'Verifying sign-in…', detail: 'Opening DRG Agent shortly.', action: 'Sign in again' },
    },
  },
  zh: {
    language: 'zh-CN', brand: 'DRG Agent', logout: '退出登录',
    noScript: '请启用 JavaScript 后重新登录，以完成身份验证',
    views: {
      entry: { title: '进入 DRG Agent', detail: '使用公司账号继续', action: '公司账号登录' },
      failure: { title: '暂时无法继续', detail: '请重新打开 DRG Agent', action: '重试' },
      signedOut: { title: '已退出登录', detail: '后台任务和私有文件予以保留', action: '公司账号登录' },
      handoff: { title: '正在打开工作区……', detail: '即将自动进入', action: '进入工作区' },
      loginFailure: { title: '登录未完成', detail: '请重新登录后继续', action: '重新登录' },
      workspaceFailure: { title: '暂时无法打开工作区', detail: '请稍后重试', action: '重试' },
      authenticating: { title: '正在验证登录……', detail: '即将进入 DRG Agent', action: '重新登录' },
    },
  },
} satisfies Record<'en' | 'zh', PageCopy>

const pageStyles = `:root{color-scheme:light dark;--dsw-alias-bg-base:rgb(255,255,255);--dsw-alias-label-primary:rgb(15,17,21);--dsw-alias-label-secondary:rgb(97,102,107);--dsw-alias-link:rgb(65,118,230);--gateway-action:rgb(15,17,21);--gateway-action-label:rgb(255,255,255);--gateway-track:rgb(225,229,238)}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100svh;display:grid;grid-template-rows:auto 1fr;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}
header{padding:28px 40px;font-size:18px;font-weight:500;letter-spacing:-.03em}
main{width:min(100%,440px);justify-self:center;align-self:center;padding:32px 24px 112px;text-align:center;overflow-wrap:anywhere}
h1{font-size:22px;font-weight:500;line-height:1.45;letter-spacing:-.025em;margin:0}
p{margin:12px 0 0;color:var(--dsw-alias-label-secondary)}
a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;max-width:100%;margin-top:28px;padding:9px 20px;border:0;border-radius:8px;background:var(--gateway-action);color:var(--gateway-action-label);font-weight:500;line-height:1.5;text-decoration:none;transition:opacity .15s}
a:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:4px}
[hidden]{display:none!important}
.spinner{display:block;width:22px;height:22px;margin:0 auto 24px;border:2px solid var(--gateway-track);border-top-color:var(--dsw-alias-link);border-radius:50%;corner-shape:round;animation:gateway-spin .9s linear infinite}
@keyframes gateway-spin{to{transform:rotate(360deg)}}
@media(hover:hover){a:hover{opacity:.8}}
@media(max-width:480px){header{padding:24px}main{padding-bottom:88px}}
@media(prefers-color-scheme:dark){:root{--dsw-alias-bg-base:rgb(21,21,23);--dsw-alias-label-primary:rgb(249,250,251);--dsw-alias-label-secondary:rgb(207,211,214);--dsw-alias-link:rgb(122,170,255);--gateway-action:rgb(249,250,251);--gateway-action-label:rgb(15,17,21);--gateway-track:rgb(67,69,74)}}
@media(prefers-reduced-motion:reduce){.spinner{animation:none}a{transition:none}}`

const callbackScript = `const fragment = location.hash;
history.replaceState(null, '', location.pathname);
const fields = new URLSearchParams(fragment.slice(1));
if (fields.get('state')) {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = '/auth/callback';
  for (const [name, value] of fields) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    Node.prototype.appendChild.call(form, input);
  }
  document.body.appendChild(form);
  HTMLFormElement.prototype.submit.call(form);
} else if (fields.size === 0 && document.getElementById('callback-status').dataset.signedIn === 'true') {
  location.replace('/');
} else {
  document.getElementById('callback-status').setAttribute('aria-busy', 'false');
  document.getElementById('spinner').hidden = true;
  const notice = document.getElementById('notice');
  notice.textContent = notice.dataset.failure;
  const detail = document.getElementById('detail');
  detail.textContent = detail.dataset.failure;
  document.getElementById('retry').hidden = false;
}`

/**
 * Escape a plain label before HTML interpolation.
 * @param value - plain text, including identity-provider display labels.
 * @returns HTML-safe text.
 */
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function documentPage(c: PageCopy, title: string, content: string, refresh = ''): string {
  return `<!doctype html><html lang="${c.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh}<title>${escapeHtml(title)} · ${c.brand}</title><style>${pageStyles}</style></head><body><header>${c.brand}</header><main>${content}</main></body></html>`
}

/**
 * Render a localized status page; handoff starts a fresh private-origin navigation.
 * @param locale - browser language header.
 * @param state - operation status; login and workspace failures have separate recovery text.
 * @param entry - validated portal or owning workspace origin used for failure recovery.
 * @param handoffTarget - server-created handoff URL, or a fresh navigation within the current private origin.
 * @returns complete document with a manual navigation fallback.
 */
export function page(locale: string | undefined, state: PageState, entry: string, handoffTarget = '/'): string {
  const c = locale?.toLowerCase().includes('zh') ? copy.zh : copy.en
  const view = c.views[state]
  const signIn = state === 'entry' || state === 'signedOut'
  const link = signIn ? '/auth/login' : state === 'handoff' ? handoffTarget : entry
  const refresh = state === 'handoff' ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(handoffTarget)}">` : ''
  const pending = state === 'handoff' ? '<span class="spinner" aria-hidden="true"></span>' : ''
  return documentPage(c, view.title, `${pending}<h1>${view.title}</h1><p>${view.detail}</p><a href="${escapeHtml(link)}">${view.action}</a>`, refresh)
}

/**
 * Bridge a fragment response to the gateway without browser storage or third-party scripts.
 * @param locale - browser language header.
 * @param signedIn - whether the server has a live browser session; an empty callback resumes through the portal.
 * @returns loading document and exact CSP script hash; unbound response fields show a sign-in retry.
 * Scripts-disabled clients receive an explicit fallback.
 */
export function implicitCallbackPage(locale: string | undefined, signedIn = false): { html: string; scriptHash: string } {
  const c = locale?.toLowerCase().includes('zh') ? copy.zh : copy.en
  const view = c.views.authenticating
  const failure = c.views.loginFailure
  const content = `<section class="pending" id="callback-status" data-signed-in="${signedIn}" role="status" aria-live="polite" aria-busy="true"><span class="spinner" id="spinner" aria-hidden="true"></span><h1 id="notice" data-failure="${escapeHtml(failure.title)}">${view.title}</h1><p id="detail" data-failure="${escapeHtml(failure.detail)}">${view.detail}</p><a id="retry" href="/" hidden>${failure.action}</a></section><noscript><style>.pending{display:none}</style><h1>${failure.title}</h1><p>${c.noScript}</p><a href="/">${failure.action}</a></noscript>`
  const html = documentPage(c, view.title, content).replace('</body>', `<script>${callbackScript}</script></body>`)
  return { html, scriptHash: createHash('sha256').update(callbackScript).digest('base64') }
}

/**
 * Publish a verified workspace identity and a server-owned POST logout form to the account UI.
 * @param html - authenticated DSH index.
 * @param name - verified display label.
 * @param locale - browser language header.
 * @returns the document with hidden account metadata, leaving application layout unchanged.
 */
export function withLogout(html: string, name: string, locale: string | undefined): string {
  const c = locale?.toLowerCase().includes('zh') ? copy.zh : copy.en
  const account = `<form id="dsh-workspace-account" data-name="${escapeHtml(name)}" method="post" action="/auth/logout" hidden><button type="submit">${c.logout}</button></form>`
  return html.replace(/<body(?:\s[^>]*)?>/iu, body => body + account)
}
