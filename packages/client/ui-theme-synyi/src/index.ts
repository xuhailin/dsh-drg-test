/** Synyi theme bootstrap over the standard Host-owned palette preference. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { SYNYI_TOKENS } from './tokens.ts'

/** Install the deployment palette before the browser application starts.
 * @param ctx - Host context owning the index-injection subscription.
 */
export function apply(ctx: Context): void {
  const background = SYNYI_TOKENS['--dsw-alias-bg-base']
  const bootBackground = `light-dark(${background.light},${background.dark})`
  ctx.on('webserver/index-inject', (table) => {
    table.push(
      // The shell's later body background must not replace the palette before token bootstrap.
      { kind: 'style', text: `html body{background-color:var(--dsw-alias-bg-base,${bootBackground});--dsh-boot-bg:${bootBackground}}` },
      {
        kind: 'script', placement: 'body',
        text: `(() => {
  const mode = document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
  const tokens = ${JSON.stringify(SYNYI_TOKENS)}
  for (const [name, modes] of Object.entries(tokens)) document.body.style.setProperty(name, modes[mode])
})()`,
      },
    )
  })
}
