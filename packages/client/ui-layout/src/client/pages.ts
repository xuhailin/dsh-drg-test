/** Query-selected standalone pages owned by the shell and registered by feature plugins. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Public registration face for a full-page component in the shell.page slot. */
export interface ClientPages {
  /** Register a page selector and its slot key.
   * @param route - URL page selector and registered shell.page key.
   * @returns Disposer that removes this route and releases its selection.
   */
  register(route: { page: string; key: string }): () => void
}

/** Shell-owned page selection preserves the served document and its proxy mount. */
export class PageRegistry implements ClientPages {
  /** Selected slot key, or null for the ordinary application frame. */
  readonly selection = createSnapshotStore<string | null>(null)
  private readonly routes = new Map<string, string>()
  /** @param search - Current browser query string, read on registration or navigation changes. */
  constructor(private readonly search: () => string) {}

  /** Register one page selector until the returned disposer runs.
   * @param route - Page selector and slot identity.
   * @returns Idempotent route disposer.
   */
  register(route: { page: string; key: string }): () => void {
    if (!/^[a-z][a-z0-9-]*$/.test(route.page) || route.key.length === 0) {
      throw new Error('Standalone pages require a lowercase page selector and a slot key.')
    }
    if (this.routes.has(route.page)) throw new Error(`A page already owns ${route.page}.`)
    this.routes.set(route.page, route.key)
    this.refresh()
    let active = true
    return () => {
      if (!active) return
      active = false
      this.routes.delete(route.page)
      this.refresh()
    }
  }

  /** Re-evaluate the browser page selector after navigation. */
  refresh(): void { this.selection.set(this.routes.get(new URLSearchParams(this.search()).get('page') ?? '') ?? null) }
}
