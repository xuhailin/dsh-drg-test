/** Reversible Synyi token overrides over the standard theme runtime. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { SYNYI_TOKENS } from '../tokens.ts'

/** The standard runtime retains theme preference and typography ownership. */
export const inject = ['theme']

/** Apply the palette for this plugin's lifetime.
 * @param ctx - Client context owning the token layer.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.theme.overrideTokens('@deepseek-ai/dsh-client-ui-theme-synyi', SYNYI_TOKENS))
}
