/** Deployment URLs and resource inputs fail before any hosted listener or runtime starts. */
import { describe, expect, it } from 'vitest'
import { Config, publicOrigin } from '../src/config.ts'

function deployment(overrides: Partial<Config> = {}): Config {
  return Config({
    publicOrigin: 'https://chat.example.test', image: 'fixture/runtime', issuer: 'https://identity.example.test',
    clientId: 'fixture-client', deepseekKeyFile: '/fixture/model-key', gatewayContainer: 'fixture-gateway',
    ...overrides,
  })
}

describe('hosted deployment configuration', () => {
  it('accepts a bare HTTPS portal and model upstream with explicit Docker resource inputs', () => {
    const config = deployment({ prefix: 'team-42', gatewayPort: 8443, runtimePort: 3081 })
    expect(publicOrigin(config).origin).toBe('https://chat.example.test')
    expect(config.allowHttp).toBe(false)
    expect(config.gatewayPort).toBe(8443)
    expect(config.runtimePort).toBe(3081)
    expect(config.oidcFlow).toBe('authorization-code')
    expect(config.maxCallbackBytes).toBe(65536)
  })

  it('accepts implicit ID-token login without a client-secret file', () => {
    const config = deployment({ oidcFlow: 'implicit', maxCallbackBytes: 8192 })
    expect(config.oidcFlow).toBe('implicit')
    expect(config.clientSecretFile).toBeUndefined()
    expect(config.maxCallbackBytes).toBe(8192)
  })

  it('rejects an unrecognized OIDC flow at configuration parsing', () => {
    expect(() => deployment({ oidcFlow: 'password' as Config['oidcFlow'] })).toThrow()
  })

  it('requires an explicit development opt-in before accepting HTTP services', () => {
    expect(() => publicOrigin(deployment({ publicOrigin: 'http://chat.localhost:8080' }))).toThrow('bare HTTPS origin')
    expect(() => publicOrigin(deployment({ deepseekBaseUrl: 'http://model.example.test/anthropic' }))).toThrow('invalid model upstream')
    expect(publicOrigin(deployment({
      publicOrigin: 'http://chat.localhost:8080', allowHttp: true, deepseekBaseUrl: 'http://model.example.test/anthropic',
    })).origin).toBe('http://chat.localhost:8080')
  })

  it.each([
    'ftp://chat.example.test',
    'https://user@chat.example.test',
    'https://:password@chat.example.test',
    'https://chat.example.test/?view=1',
    'https://chat.example.test/#view',
    'https://chat.example.test/prefix/',
  ])('rejects a portal whose authority or routes would change (%s)', (publicOriginValue) => {
    expect(() => publicOrigin(deployment({ publicOrigin: publicOriginValue }))).toThrow('bare HTTPS origin')
  })

  it.each(['https://localhost', 'https://127.0.0.1', 'https://[::1]'])('requires a portal DNS name that can own personal subdomains (%s)', (publicOriginValue) => {
    expect(() => publicOrigin(deployment({ publicOrigin: publicOriginValue }))).toThrow('DNS name supporting user subdomains')
  })

  it.each(['1team', 'team_with_underscore', 'a'.repeat(32)])('rejects a Docker prefix that cannot name its owned resources (%s)', (prefix) => {
    expect(() => publicOrigin(deployment({ prefix }))).toThrow('invalid Docker resource prefix')
  })

  it('requires at least one allowed model', () => {
    expect(() => publicOrigin(deployment({ allowedModels: [] }))).toThrow('allowedModels must not be empty')
  })

  it.each([
    'ftp://model.example.test',
    'https://user@model.example.test',
    'https://:password@model.example.test',
    'https://model.example.test/anthropic?key=value',
    'https://model.example.test/anthropic#value',
  ])('rejects a model upstream with unsupported transport or hidden credentials (%s)', (deepseekBaseUrl) => {
    expect(() => publicOrigin(deployment({ deepseekBaseUrl }))).toThrow('invalid model upstream')
  })

  it.each([
    { gatewayPort: 0 },
    { runtimePort: 65536 },
    { sessionTtlMs: 2147483648 },
    { containerMemoryBytes: 0 },
    { maxConcurrentModelRequests: 0 },
    { maxCallbackBytes: 0 },
    { maxCallbackBytes: 1.5 },
  ])('rejects invalid deployment limits at configuration parsing (%j)', (overrides) => {
    expect(() => deployment(overrides)).toThrow()
  })
})
