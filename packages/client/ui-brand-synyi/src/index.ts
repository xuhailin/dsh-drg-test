/** Synyi Web metadata and public brand assets for the companion browser entry. */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Host service owning the index document and asset routes. */
export const inject = ['webServer']

const ASSETS = [
  { name: 'favicon.svg', type: 'image/svg+xml' },
  { name: 'favicon-dark.svg', type: 'image/svg+xml' },
  { name: 'manifest.webmanifest', type: 'application/manifest+json' },
] as const

const BRAND_LINKS = [
  '<link rel="manifest" href="synyi-brand/manifest.webmanifest" />',
  '<link rel="icon" type="image/svg+xml" href="synyi-brand/favicon-dark.svg" media="(prefers-color-scheme: dark)" />',
  '<link rel="icon" type="image/svg+xml" href="synyi-brand/favicon.svg" media="(prefers-color-scheme: light)" />',
].join('\n')

/** Replace the shell's brand links while retaining unrelated link metadata. */
function brandIndex(html: string): string {
  const stripped = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const relation = /\srel\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2]
    return relation?.split(/\s+/).some(value => value === 'icon' || value === 'manifest') ? '' : tag
  })
  if (!/<\/head\s*>/i.test(stripped)) throw new Error('ui-brand-synyi: index document has no closing head element')
  return stripped.replace(/<\/head\s*>/i, `${BRAND_LINKS}\n</head>`)
}

/**
 * Serve the packaged brand assets and replace the shell's favicon and manifest links.
 * Missing assets fail activation; disposal removes the routes and index transform.
 * @param ctx Host context providing the Web server.
 */
export function apply(ctx: Context): void {
  const assets = ASSETS.map(asset => ({
    ...asset,
    body: readFileSync(new URL(`../assets/${asset.name}`, import.meta.url)),
  }))
  for (const asset of assets) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `/synyi-brand/${asset.name}`,
      handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': asset.type, 'content-length': asset.body.byteLength })
        res.end(req.method === 'HEAD' ? undefined : asset.body)
      },
    }))
  }
  ctx.effect(() => ctx.webServer.tapIndex(brandIndex))
}
