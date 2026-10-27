import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { HostedRuntimeActor } from '@deepseek-ai/dsh-experimental-hosted-workspaces'
import { expect, it, onTestFinished } from 'vitest'
import { PathwayPolicy } from '../src/policy.ts'

const actor: HostedRuntimeActor = {
  id: brandString<HostedRuntimeActor['id']>('synthetic-account'), issuer: 'https://identity.test', subject: 'reader-one',
}
const grant = {
  issuer: actor.issuer, subject: actor.subject, sourceSystem: 'synthetic-clinical', hospitalCode: 'hospital-one',
  departmentCodes: ['department-one', 'department-two'], departmentBasis: 'discharge',
  admissionFrom: '2025-01-01T00:00:00Z', admissionTo: '2026-01-01T00:00:00Z',
}

async function fixture(value: unknown = { schemaVersion: 1, grants: [grant] }, maxBytes = 65536) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pathway-policy-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'policy.json')
  await writeFile(file, JSON.stringify(value))
  return { policy: new PathwayPolicy(file, maxBytes, 'synthetic-clinical'), file }
}

it('keeps historical admission dates, department basis and shared-definition access operator-owned', async () => {
  const { policy } = await fixture()
  await expect(policy.validate()).resolves.toBeUndefined()
  const scope = await policy.select(actor, { departmentCodes: ['department-two', 'department-two'] })
  expect(scope).toEqual({ hospitalCode: grant.hospitalCode, departmentCodes: ['department-two'], departmentBasis: 'discharge',
    admissionFrom: grant.admissionFrom, admissionTo: grant.admissionTo, includeSharedDefinitions: false })
  scope.departmentCodes.push('outside')
  expect((await policy.select(actor, {})).departmentCodes).toEqual(grant.departmentCodes)
})

it('admits explicitly granted shared definitions and requires a hospital when the account has several grants', async () => {
  const { policy } = await fixture({ schemaVersion: 1, grants: [
    { ...grant, includeSharedDefinitions: true }, { ...grant, hospitalCode: 'hospital-two' },
  ] })
  await expect(policy.select(actor, {})).rejects.toMatchObject({ code: 'invalid-request' })
  await expect(policy.select(actor, { hospitalCode: 'hospital-one' })).resolves.toMatchObject({ includeSharedDefinitions: true })
  await expect(policy.select(actor, { hospitalCode: 'hospital-two' })).resolves.toMatchObject({ includeSharedDefinitions: false })
})

it.each([
  { actor: { ...actor, issuer: 'https://foreign.test' }, selection: {} },
  { actor: { ...actor, subject: 'other-account' }, selection: {} },
  { actor, selection: { hospitalCode: 'hospital-other' } },
  { actor, selection: { departmentCodes: ['department-one', 'department-other'] } },
  { actor, selection: { departmentCodes: [] } },
])('denies identities and filters outside the independent historical grant: %j', async (request) => {
  const { policy } = await fixture()
  await expect(policy.select(request.actor, request.selection)).rejects.toMatchObject({ code: 'forbidden' })
})

it('does not reuse another source or current-inpatient authorization as a historical grant', async () => {
  const { policy, file } = await fixture({ schemaVersion: 1, grants: [{ ...grant, sourceSystem: 'other-source' }] })
  await expect(policy.select(actor, {})).rejects.toMatchObject({ code: 'forbidden' })
  await writeFile(file, JSON.stringify({ schemaVersion: 1, entries: [{ ...grant, inpatId: '100' }] }))
  await expect(policy.select(actor, {})).rejects.toMatchObject({ code: 'source-unavailable' })
})

it.each([
  { ...grant, admissionFrom: grant.admissionTo },
  { ...grant, admissionTo: '2024-01-01T00:00:00Z' },
  { ...grant, admissionFrom: '2025-01-01' },
  { ...grant, departmentBasis: 'unknown' },
  { ...grant, departmentCodes: [] },
  { ...grant, sql: 'synthetic-private-detail' },
])('rejects invalid historical grants without exposing their contents: %j', async (invalid) => {
  const { policy } = await fixture({ schemaVersion: 1, grants: [invalid] })
  await expect(policy.validate()).rejects.toMatchObject({ code: 'source-unavailable',
    message: 'Pathway access policy is unavailable or invalid. Ask the operator to repair its configuration.' })
})

it('rejects duplicate account/source/hospital grants and over-limit private files', async () => {
  const duplicated = await fixture({ schemaVersion: 1, grants: [grant, { ...grant, departmentCodes: ['another'] }] })
  await expect(duplicated.policy.validate()).rejects.toMatchObject({ code: 'source-unavailable' })
  const oversized = await fixture({ schemaVersion: 1, grants: [grant] }, 32)
  await expect(oversized.policy.validate()).rejects.toMatchObject({ code: 'source-unavailable' })
})

it('re-reads changed and revoked grants and fails closed on missing or malformed files', async () => {
  const { policy, file } = await fixture()
  await expect(policy.select(actor, {})).resolves.toMatchObject({ departmentBasis: 'discharge' })
  await writeFile(file, JSON.stringify({ schemaVersion: 1, grants: [{ ...grant, departmentBasis: 'current' }] }))
  await expect(policy.select(actor, {})).resolves.toMatchObject({ departmentBasis: 'current' })
  await writeFile(file, JSON.stringify({ schemaVersion: 1, grants: [] }))
  await expect(policy.select(actor, {})).rejects.toMatchObject({ code: 'forbidden' })
  await writeFile(file, 'synthetic-private-invalid-json')
  await expect(policy.validate()).rejects.toMatchObject({ code: 'source-unavailable' })
  await rm(file)
  await expect(policy.validate()).rejects.toMatchObject({ code: 'source-unavailable' })
})
