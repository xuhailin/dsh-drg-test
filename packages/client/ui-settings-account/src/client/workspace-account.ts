/** Server-authenticated workspace identity consumed by the account launcher. */

/** Workspace login remains independent of model-provider credentials. */
export interface WorkspaceAccount {
  /** Verified identity-provider display name. */
  name: string
  /** Submit the gateway-owned logout form through a document navigation. */
  signOut: () => void
}

/**
 * Read the gateway's account form once during client activation.
 * @param document - authenticated application document, absent on non-browser hosts.
 * @returns the workspace identity and logout action, or nothing for an ordinary DSH client.
 */
export function readWorkspaceAccount(document: Document | undefined): WorkspaceAccount | undefined {
  const form = document?.querySelector<HTMLFormElement>('form#dsh-workspace-account')
  if (!form) return undefined
  const name = form.getAttribute('data-name')
  if (name === null) throw new Error('Workspace account is missing its display name')
  return { name, signOut: () => { form.requestSubmit() } }
}
