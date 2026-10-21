/** Optional profile bundle for company SSO and per-user Docker-backed DSH workspaces. */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { Config, publicOrigin } from './config.ts'
import { hostedDomain, HostedState } from './state.ts'
import { OidcLogin } from './oidc.ts'
import { DockerRuntimes } from './docker.ts'
import { ModelProxy } from './model.ts'
import { HostedGateway } from './gateway.ts'

export { Config }
/** Cordis plugin identity. */
export const name = 'hosted-workspaces'
/** Required Host services; this optional profile mounts no agent in the gateway. */
export const inject = ['webServer', 'storageDomain']

async function secret(path: string): Promise<string> {
  const value = (await readFile(path, 'utf8')).trim()
  if (value.length === 0) throw new Error('hosted-workspaces: configured secret file is empty')
  return value
}

/**
 * Install the optional SSO gateway, authenticated runtime proxy and model gateway.
 * @param ctx - profile-scoped Host context.
 * @param config - validated deployment inputs.
 * @returns completion of discovery and route installation.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const entry = publicOrigin(config)
  const key = await secret(config.deepseekKeyFile)
  const domain = await ctx.storageDomain.open(hostedDomain)
  ctx.effect(() => () => domain.close(), 'hosted-workspaces: private records')
  const oidc = await OidcLogin.create({
    issuer: config.issuer, clientId: config.clientId, redirectUri: `${entry.origin}/auth/callback`,
    ...(config.discoveryUrl === undefined ? {} : { discoveryUrl: config.discoveryUrl }),
    ...(config.clientSecretFile === undefined ? {} : { clientSecret: await secret(config.clientSecretFile) }),
    allowInsecureHttp: config.allowHttp, flowTtlMs: config.flowTtlMs,
    maxPendingFlows: config.maxPendingFlows, requestTimeoutMs: config.requestTimeoutMs,
  })
  const state = new HostedState(domain, config.maxUsers, config.maxBrowserSessions)
  const model = new ModelProxy(config, state, key)
  const runtimes = new DockerRuntimes({
    socketPath: config.dockerSocket, image: config.image, gatewayContainer: config.gatewayContainer,
    gatewayPort: config.gatewayPort, prefix: config.prefix, memoryBytes: config.containerMemoryBytes,
    nanoCpus: config.containerNanoCpus, pidsLimit: config.containerPidsLimit, tmpBytes: config.containerTmpBytes,
    startupTimeoutMs: config.startupTimeoutMs, runtimePort: config.runtimePort, maxUsers: config.maxUsers,
  }, { onNetwork: host => model.listenOn(host) })
  const gateway = new HostedGateway(config, state, oidc, runtimes, model)
  ctx.effect(() => () => gateway.dispose(), 'hosted-workspaces: admitted work')
  ctx.effect(() => ctx.webServer.registerFallback((req, res) => gateway.handle(req, res)), 'hosted-workspaces: HTTP entry')
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/api/remote.mux', handler: (req, socket, head) => gateway.upgrade(req, socket, head) }), 'hosted-workspaces: WebSocket entry')
}
