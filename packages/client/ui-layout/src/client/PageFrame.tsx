/** Select a registered standalone page before mounting any conversation UI. */
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { AppFrame, type AppFrameProps } from './AppFrame.tsx'
import type { PageRegistry } from './pages.ts'

/** Renderer-bound page selection, owned by the layout plugin. */
export type PageInjected = InjectFace<{ hooks: { page: PageRegistry['selection'] } }>
/** The root shell's declared slots and framework-bound selection. */
export type PageFrameProps = AppFrameProps & PropsRenderSlots<'shell.page'> & PageInjected

/** Mount either a standalone page or the ordinary frame.
 * @param props - Framework shares and the current registered page.
 * @returns Selected page without the conversation frame, or the application frame.
 */
export function PageFrame(props: PageFrameProps) {
  const page = props.usePage(value => value)
  return page === null ? <AppFrame {...props} /> : props.renderSlot('shell.page', {}, { entryKey: page })
}
