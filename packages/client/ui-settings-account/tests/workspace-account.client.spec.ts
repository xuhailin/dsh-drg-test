// @vitest-environment jsdom
/** Workspace identity uses the gateway form without reading or changing model credentials. */
import { afterEach, expect, it, vi } from 'vitest'
import { readWorkspaceAccount } from '../src/client/workspace-account.ts'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

it('leaves ordinary Web and non-browser clients without a workspace account', () => {
  expect(readWorkspaceAccount(undefined)).toBeUndefined()
  expect(readWorkspaceAccount(document)).toBeUndefined()
})

it('reads the verified label and submits the gateway logout form', () => {
  const form = document.createElement('form')
  form.id = 'dsh-workspace-account'
  form.method = 'post'
  form.action = '/auth/logout'
  form.hidden = true
  const name = '<script>Company User & Doctor</script>'
  form.setAttribute('data-name', name)
  document.body.append(form)
  const submit = vi.spyOn(form, 'requestSubmit').mockImplementation(() => {})
  const account = readWorkspaceAccount(document)
  expect(account?.name).toBe(name)
  expect(document.querySelector('script')).toBeNull()
  expect(submit).not.toHaveBeenCalled()
  account?.signOut()
  expect(submit).toHaveBeenCalledOnce()
  expect(form.method).toBe('post')
  expect(form.getAttribute('action')).toBe('/auth/logout')
})

it('rejects incomplete workspace account metadata', () => {
  document.body.innerHTML = '<form id="dsh-workspace-account" hidden></form>'
  expect(() => readWorkspaceAccount(document)).toThrow('Workspace account is missing its display name')
})
