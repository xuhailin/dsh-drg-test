/** Synyi artwork shared by the sidebar and conversation welcome screen. */
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import mark from './synyi-mark.png'
import css from './Brand.module.css'

/**
 * Render the existing Synyi mark at the requesting surface's size.
 * @param props - Host-owned mark dimensions and optional presentation class.
 * @returns the Synyi mark.
 */
export function SynyiBrandMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <img
    src={mark}
    width={size}
    height={size}
    alt=""
    className={[css.mark, className].filter(Boolean).join(' ')}
    data-brand="synyi"
  />
}

/**
 * Render the localized Synyi name beside the independently slotted mark.
 * @param props - Framework-provided brand translations.
 * @returns the Synyi brand name.
 */
export function SynyiBrandName({ t }: PropsLocale<'synyiBrand'>) {
  return <span className={css.name}>{t('brand.name')}</span>
}
