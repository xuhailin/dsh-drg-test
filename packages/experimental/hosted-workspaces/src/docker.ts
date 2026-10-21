/** Docker resources and browser authentication for isolated, persistent user runtimes. */
import { request as httpRequest } from 'node:http'
import { isIP } from 'node:net'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import Docker from 'dockerode'
import type { HostedUserId } from './state.ts'

/** Deployment limits applied to every personal runtime. */
export interface DockerRuntimeOptions {
  socketPath: string
  image: string
  gatewayContainer: string
  gatewayPort: number
  prefix: string
  memoryBytes: number
  nanoCpus: number
  pidsLimit: number
  tmpBytes: number
  startupTimeoutMs: number
  runtimePort: number
  maxUsers: number
}

/** Stable identity and scoped model credential supplied by the gateway. */
export interface DockerRuntimeUser {
  id: HostedUserId
  modelToken: string
  origin: string
}

/** Private upstream address and server-only DSH browser credential. */
export interface DockerRuntime {
  target: string
  cookie: string
  containerId: string
}

interface ContainerInspection {
  Id: string
  Image: string
  Name: string
  Config: {
    Image: string
    User: string
    Labels?: Record<string, string> | null
    Env?: string[] | null
    Entrypoint?: string | string[] | null | undefined
    Cmd?: string[] | null
  }
  HostConfig: {
    NetworkMode?: string | undefined
    ReadonlyRootfs?: boolean | undefined
    Privileged?: boolean | undefined
    CapAdd?: string[] | null | undefined
    CapDrop?: string[] | null | undefined
    SecurityOpt?: string[] | null | undefined
    Init?: boolean | undefined
    Memory?: number | undefined
    NanoCpus?: number | undefined
    PidsLimit?: number | null | undefined
    Tmpfs?: Record<string, string> | null | undefined
    Binds?: string[] | null | undefined
    Devices?: unknown[] | null | undefined
    PortBindings?: Record<string, unknown> | null | undefined
    PublishAllPorts?: boolean | undefined
    PidMode?: string | undefined
    IpcMode?: string | undefined
    UTSMode?: string | undefined
  }
  State: { Running: boolean; Status: string; StartedAt: string }
  Mounts: { Type: string; Name?: string | undefined; Destination: string; RW: boolean }[]
  NetworkSettings: {
    Networks: Record<string, { NetworkID: string; IPAddress: string; Aliases?: string[] | null | undefined }>
  }
}

interface NetworkInspection {
  Id: string
  Name: string
  Driver: string
  Labels?: Record<string, string> | null | undefined
  Internal?: boolean
  Options?: Record<string, string> | null | undefined
  Containers?: Record<string, { Name: string; IPv4Address?: string | undefined }> | undefined
}

interface ImageInspection {
  Id: string
  Config: { Entrypoint?: string | string[] | null | undefined; Cmd?: string[] | null; Env?: string[] | null }
}

interface VolumeInspection {
  Name: string
  Driver: string
  Labels?: Record<string, string> | null
  Options?: Record<string, string> | null
}

interface RuntimeContainer {
  inspect(): Promise<ContainerInspection>
  start(): Promise<unknown>
  launchToken(since: string, signal: AbortSignal): Promise<string | undefined>
  remove(): Promise<unknown>
}

interface RuntimeNetwork {
  inspect(): Promise<NetworkInspection>
  connect(container: string): Promise<unknown>
  disconnect(container: string): Promise<unknown>
  remove(): Promise<unknown>
}

interface RuntimeVolume {
  inspect(): Promise<VolumeInspection>
  remove(): Promise<unknown>
}

/** Narrow Docker operations injected by focused tests without accessing a daemon. */
export interface DockerRuntimeBackend {
  inspectImage(image: string): Promise<ImageInspection>
  getContainer(id: string): RuntimeContainer
  createContainer(options: Docker.ContainerCreateOptions): Promise<RuntimeContainer>
  getNetwork(name: string): RuntimeNetwork
  createNetwork(options: Docker.NetworkCreateOptions): Promise<unknown>
  getVolume(name: string): RuntimeVolume
  createVolume(options: Docker.VolumeCreateOptions): Promise<unknown>
  listContainers(): Promise<{ Labels: Record<string, string> }[]>
}

/** Instance-local external operations; omitted dependencies use Docker and Node HTTP. */
export interface DockerRuntimeDependencies {
  docker?: DockerRuntimeBackend
  request?: (url: string, init: { headers: { host: string }; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>
  /** Bind the restricted model listener on the gateway's new private-network address before starting its runtime. */
  onNetwork?: (gatewayIp: string) => Promise<void>
}

/** Stable failure identities; messages exclude Docker responses and launch credentials. */
export class DockerRuntimeError extends Error {
  constructor(readonly code: 'disposed' | 'resource_conflict' | 'capacity' | 'docker_unavailable' | 'startup_failed' | 'startup_timeout' | 'cleanup_failed') {
    super(`Personal runtime operation failed (${code}).`)
    this.name = 'DockerRuntimeError'
  }
}

const OWNER_LABEL = 'ai.deepseek.dsh.hosted-workspaces'

function exchangeRequest(url: string, init: { headers: { host: string }; signal: AbortSignal }): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let result: Response | undefined
    let failure: Error | undefined
    const request = httpRequest(url, { headers: init.headers, signal: init.signal, agent: false }, (response) => {
      response.once('error', (error: Error) => { failure = error })
      response.once('end', () => {
        const headers = new Headers()
        for (const cookie of response.headers['set-cookie'] ?? []) headers.append('set-cookie', cookie)
        // Node populates statusCode before emitting a client response.
        const status = response.statusCode as number
        if (status < 200 || status > 599) failure = new DockerRuntimeError('startup_failed')
        else result = new Response(null, { status, headers })
      })
      response.resume()
    })
    request.once('error', (error: Error) => { failure = error })
    request.once('close', () => {
      if (failure !== undefined) reject(failure)
      else if (result !== undefined) resolve(result)
      else reject(new DockerRuntimeError('startup_failed'))
    })
    request.end()
  })
}

/** Docker log filters use Unix seconds while retaining the launch timestamp's fractional precision. */
function logSince(startedAt: string): string {
  const timestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(startedAt)
  if (timestamp === null) throw new DockerRuntimeError('startup_failed')
  const seconds = Date.parse(`${timestamp[1]}${timestamp[3]}`) / 1000
  if (!Number.isSafeInteger(seconds)) throw new DockerRuntimeError('startup_failed')
  return `${seconds}${timestamp[2] === undefined ? '' : `.${timestamp[2]}`}`
}

function backend(options: DockerRuntimeOptions): DockerRuntimeBackend {
  // dockerode otherwise lets an ambient DOCKER_HOST take precedence over socketPath.
  const docker = new Docker({ host: undefined, protocol: 'http', socketPath: options.socketPath, timeout: options.startupTimeoutMs })
  const container = (value: Docker.Container): RuntimeContainer => ({
    inspect: () => value.inspect(),
    start: () => value.start(),
    launchToken: async (since, signal) => {
      // dockerode's follow:true path returns Node's untouched HTTP response stream.
      const stream = await value.logs({ stdout: true, stderr: true, follow: true, since: logSince(since) }) as Readable
      const abort = (): void => { stream.destroy(new DockerRuntimeError('startup_timeout')) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      try {
        let pending = ''
        for await (const chunk of stream) {
          pending += (chunk as Buffer).toString('utf8')
          const token = /dsh web: https?:\/\/[^\s]+[?&]token=([A-Za-z0-9_-]+)(?=\s)/u.exec(pending)?.[1]
          if (token !== undefined) return token
          // Only the unfinished startup line is retained; Docker multiplex framing may precede it.
          pending = pending.slice(pending.lastIndexOf('\n') + 1).slice(-8192)
        }
        return undefined
      } finally {
        signal.removeEventListener('abort', abort)
        stream.destroy()
      }
    },
    remove: () => value.remove({ force: true }),
  })
  return {
    inspectImage: image => docker.getImage(image).inspect(),
    getContainer: id => container(docker.getContainer(id)),
    createContainer: async config => container(await docker.createContainer(config)),
    getNetwork: (name) => {
      const value = docker.getNetwork(name)
      return {
        inspect: () => value.inspect(),
        connect: id => value.connect({ Container: id, EndpointConfig: { Aliases: ['gateway'] } }),
        disconnect: id => value.disconnect({ Container: id, Force: true }),
        remove: () => value.remove(),
      }
    },
    createNetwork: config => docker.createNetwork(config),
    getVolume: (name) => {
      const value = docker.getVolume(name)
      return { inspect: () => value.inspect(), remove: () => value.remove() }
    },
    createVolume: config => docker.createVolume(config),
    listContainers: () => docker.listContainers({ all: true, filters: JSON.stringify({ label: [`${OWNER_LABEL}=1`, `${OWNER_LABEL}.instance=${options.prefix}`] }) }),
  }
}

function missing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404
}

async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try { return await read() } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

function requireIsolation(condition: boolean): asserts condition {
  if (!condition) throw new DockerRuntimeError('resource_conflict')
}

function equalLabels(actual: Record<string, string> | null | undefined, expected: Record<string, string>): boolean {
  return actual !== null && actual !== undefined
    && Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => actual[key] === value)
}

/**
 * Owns startup operations; established runtimes and data survive gateway disposal.
 * Failed starts remove only resources created by that operation. Cleanup failure
 * rejects explicitly, leaving remaining resources for operator inspection.
 */
export class DockerRuntimes {
  private readonly docker: DockerRuntimeBackend
  private readonly request: NonNullable<DockerRuntimeDependencies['request']>
  private readonly onNetwork: NonNullable<DockerRuntimeDependencies['onNetwork']>
  private readonly pending = new Map<HostedUserId, Promise<DockerRuntime>>()
  private readonly reservations = new Set<HostedUserId>()
  private readonly lifetime = new AbortController()
  private quota: Promise<void> = Promise.resolve()

  constructor(private readonly options: DockerRuntimeOptions, dependencies: DockerRuntimeDependencies = {}) {
    this.docker = dependencies.docker ?? backend(options)
    this.request = dependencies.request ?? exchangeRequest
    this.onNetwork = dependencies.onNetwork ?? (async () => {})
  }

  /**
   * Start or validate a user's existing runtime and exchange its current launch token.
   * @param user stable identity, model credential, and public origin.
   * @returns private runtime address and a server-only authenticated browser cookie.
   */
  ensure(user: DockerRuntimeUser): Promise<DockerRuntime> {
    if (this.lifetime.signal.aborted) return Promise.reject(new DockerRuntimeError('disposed'))
    const current = this.pending.get(user.id)
    if (current !== undefined) return current
    const operation = this.start(user).finally(() => this.pending.delete(user.id))
    this.pending.set(user.id, operation)
    return operation
  }

  /** Stop accepting startups and await their rollback without deleting established runtimes. */
  async dispose(): Promise<void> {
    this.lifetime.abort(new DockerRuntimeError('disposed'))
    await Promise.allSettled([...this.pending.values()])
  }

  private async reserve(id: HostedUserId): Promise<void> {
    const previous = this.quota
    const reservation = Promise.withResolvers<void>()
    this.quota = reservation.promise
    await previous
    try {
      const users = new Set((await this.docker.listContainers()).map(value => value.Labels[`${OWNER_LABEL}.user`]))
      for (const reserved of this.reservations) users.add(reserved)
      if (!users.has(id) && users.size >= this.options.maxUsers) throw new DockerRuntimeError('capacity')
      this.reservations.add(id)
    } finally { reservation.resolve() }
  }

  private async start(user: DockerRuntimeUser): Promise<DockerRuntime> {
    const controller = new AbortController()
    const dispose = (): void => { controller.abort(new DockerRuntimeError('disposed')) }
    this.lifetime.signal.addEventListener('abort', dispose, { once: true })
    const timeout = setTimeout(() => { controller.abort(new DockerRuntimeError('startup_timeout')) }, this.options.startupTimeoutMs)
    const signal = controller.signal
    const cleanups: (() => Promise<unknown>)[] = []
    try {
      await this.reserve(user.id)
      signal.throwIfAborted()
      const result = await this.provision(user, cleanups, signal)
      signal.throwIfAborted()
      return result
    } catch (error) {
      let failedCleanup = false
      for (const cleanup of cleanups.reverse()) {
        try { await cleanup() } catch (cleanupError) {
          // Resource ownership is retained by Docker when removal fails; report that state explicitly.
          void cleanupError
          failedCleanup = true
          break
        }
      }
      if (failedCleanup) throw new DockerRuntimeError('cleanup_failed')
      if (signal.aborted) throw signal.reason
      if (error instanceof DockerRuntimeError) throw error
      throw new DockerRuntimeError('docker_unavailable')
    } finally {
      clearTimeout(timeout)
      this.lifetime.signal.removeEventListener('abort', dispose)
      this.reservations.delete(user.id)
    }
  }

  private async provision(user: DockerRuntimeUser, cleanups: (() => Promise<unknown>)[], signal: AbortSignal): Promise<DockerRuntime> {
    const name = `${this.options.prefix}-${user.id}`
    const volumeName = `${name}-home`
    const labels = { [OWNER_LABEL]: '1', [`${OWNER_LABEL}.instance`]: this.options.prefix, [`${OWNER_LABEL}.user`]: user.id }
    const volume = this.docker.getVolume(volumeName)
    const existingVolume = await optional(() => volume.inspect())
    if (existingVolume === undefined) {
      signal.throwIfAborted()
      await this.docker.createVolume({ Name: volumeName, Driver: 'local', Labels: labels })
    }
    const storedVolume = await volume.inspect()
    requireIsolation(storedVolume.Name === volumeName && storedVolume.Driver === 'local'
      && equalLabels(storedVolume.Labels, labels) && Object.keys(storedVolume.Options ?? {}).length === 0)
    if (existingVolume === undefined) cleanups.push(() => volume.remove())
    const network = this.docker.getNetwork(name)
    const existingNetwork = await optional(() => network.inspect())
    if (existingNetwork === undefined) {
      signal.throwIfAborted()
      await this.docker.createNetwork({ Name: name, Driver: 'bridge', Internal: false, Labels: labels })
    }
    const storedNetwork = await network.inspect()
    requireIsolation(storedNetwork.Name === name && storedNetwork.Driver === 'bridge' && storedNetwork.Internal === false
      && equalLabels(storedNetwork.Labels, labels) && Object.keys(storedNetwork.Options ?? {}).length === 0)
    if (existingNetwork === undefined) cleanups.push(() => network.remove())
    const gateway = await this.docker.getContainer(this.options.gatewayContainer).inspect()
    const members = Object.keys(storedNetwork.Containers ?? {})
    const existing = await optional(() => this.docker.getContainer(name).inspect())
    requireIsolation(members.every(id => id === gateway.Id || id === existing?.Id))
    const gatewayEndpoint = gateway.NetworkSettings.Networks[name]
    if (gatewayEndpoint === undefined) {
      signal.throwIfAborted()
      await network.connect(gateway.Id)
      cleanups.push(() => network.disconnect(gateway.Id))
    } else {
      requireIsolation(gatewayEndpoint.NetworkID === storedNetwork.Id && gatewayEndpoint.Aliases?.includes('gateway') === true)
    }
    const connected = await network.inspect()
    requireIsolation(connected.Id === storedNetwork.Id)
    const gatewayIp = connected.Containers?.[gateway.Id]?.IPv4Address?.split('/', 1)[0]
    requireIsolation(gatewayIp !== undefined && isIP(gatewayIp) === 4)
    signal.throwIfAborted()
    try { await this.onNetwork(gatewayIp) } catch (_listenerError) {
      // The listener owner rolls back its own partial acquisition; Docker retains ownership of the runtime resources.
      throw new DockerRuntimeError('startup_failed')
    }
    signal.throwIfAborted()
    const env = [
      'HOME=/home/node', 'DSH_HOME=/home/node/.dsh', 'DSH_AGENTS_HOME=/home/node/.agents',
      `DEEPSEEK_API_KEY=${user.modelToken}`, `DEEPSEEK_BASE_URL=http://gateway:${String(this.options.gatewayPort)}/model`,
      `HOSTED_PUBLIC_URL=${user.origin}`, `HOSTED_RUNTIME_PORT=${String(this.options.runtimePort)}`,
    ]
    const image = await this.docker.inspectImage(this.options.image)
    const config: Docker.ContainerCreateOptions = {
      name, Image: this.options.image, User: '1000:1000', Env: env, Labels: labels,
      HostConfig: {
        NetworkMode: name, ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'], Init: true,
        Memory: this.options.memoryBytes, NanoCpus: this.options.nanoCpus, PidsLimit: this.options.pidsLimit,
        Tmpfs: { '/tmp': `rw,nosuid,nodev,size=${String(this.options.tmpBytes)},mode=1777` },
        Mounts: [{ Type: 'volume', Source: volumeName, Target: '/home/node', ReadOnly: false }],
      },
    }
    let runtime = this.docker.getContainer(name)
    if (existing === undefined) {
      signal.throwIfAborted()
      runtime = await this.docker.createContainer(config)
      const created = runtime
      cleanups.push(() => created.remove())
    }
    let inspection = await runtime.inspect()
    this.checkContainer(inspection, image, name, volumeName, storedNetwork.Id, labels, env, 'before-start')
    signal.throwIfAborted()
    if (!inspection.State.Running) {
      await runtime.start()
      inspection = await runtime.inspect()
      this.checkContainer(inspection, image, name, volumeName, storedNetwork.Id, labels, env, 'after-start')
    }
    return this.waitForBrowser(runtime, inspection, name, user.origin, signal)
  }

  private checkContainer(
    value: ContainerInspection, image: ImageInspection, name: string, volume: string,
    networkId: string, labels: Record<string, string>, env: string[], phase: 'before-start' | 'after-start',
  ): void {
    const host = value.HostConfig
    const endpoint = value.NetworkSettings.Networks[name]
    const expectedEnv = new Map((image.Config.Env ?? []).map(entry => [entry.split('=', 1)[0], entry]))
    for (const entry of env) expectedEnv.set(entry.split('=', 1)[0], entry)
    requireIsolation(value.Name === `/${name}` && value.Image === image.Id && value.Config.Image === this.options.image && value.Config.User === '1000:1000'
      && equalLabels(value.Config.Labels, labels)
      && JSON.stringify([...(value.Config.Env ?? [])].sort()) === JSON.stringify([...expectedEnv.values()].sort())
      && JSON.stringify(value.Config.Entrypoint ?? null) === JSON.stringify(image.Config.Entrypoint ?? null)
      && JSON.stringify(value.Config.Cmd ?? null) === JSON.stringify(image.Config.Cmd ?? null)
      && host.NetworkMode === name && host.ReadonlyRootfs === true && host.Privileged === false
      && (host.CapAdd?.length ?? 0) === 0 && host.CapDrop?.length === 1 && host.CapDrop[0] === 'ALL'
      && host.SecurityOpt?.length === 1 && host.SecurityOpt[0] === 'no-new-privileges:true' && host.Init === true
      && host.Memory === this.options.memoryBytes && host.NanoCpus === this.options.nanoCpus && host.PidsLimit === this.options.pidsLimit
      && Object.keys(host.Tmpfs ?? {}).length === 1
      && host.Tmpfs?.['/tmp'] === `rw,nosuid,nodev,size=${String(this.options.tmpBytes)},mode=1777`
      && (host.Binds?.length ?? 0) === 0 && (host.Devices?.length ?? 0) === 0
      && Object.keys(host.PortBindings ?? {}).length === 0 && host.PublishAllPorts !== true
      && (host.PidMode ?? '') === '' && (host.UTSMode ?? '') === ''
      && ['', 'private'].includes(host.IpcMode ?? '')
      && value.Mounts.length === 1 && value.Mounts[0]?.Type === 'volume' && value.Mounts[0].Name === volume
      && value.Mounts[0].Destination === '/home/node' && value.Mounts[0].RW
      && Object.keys(value.NetworkSettings.Networks).length === 1
      && endpoint !== undefined)
    // Docker assigns the private network ID when a created container first starts.
    const pendingNetwork = phase === 'before-start' && !value.State.Running && value.State.Status === 'created'
    requireIsolation((pendingNetwork ? ['', networkId] : [networkId]).includes(endpoint.NetworkID))
  }

  private async waitForBrowser(
    runtime: RuntimeContainer, initial: ContainerInspection, name: string, origin: string, signal: AbortSignal,
  ): Promise<DockerRuntime> {
    let inspection = initial
    for (;;) {
      signal.throwIfAborted()
      if (!inspection.State.Running) throw new DockerRuntimeError('startup_failed')
      const address = inspection.NetworkSettings.Networks[name]?.IPAddress
      if (address !== undefined && isIP(address) === 4) {
        const target = `http://${address}:${String(this.options.runtimePort)}`
        const token = await runtime.launchToken(inspection.State.StartedAt, signal)
        if (token !== undefined) {
          let response: Response | undefined
          try {
            response = await this.request(`${target}/?token=${encodeURIComponent(token)}`, {
              headers: { host: new URL(origin).host }, redirect: 'manual', signal,
            })
          } catch (_requestError) {
            // Connection refusal is expected while the current process binds; never retain its credential-bearing URL.
            if (signal.aborted) throw signal.reason
          }
          if (response !== undefined) {
            await response.body?.cancel()
            const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
            if (response.status === 303 && cookie?.startsWith('dsh-auth-') === true) {
              return { target, cookie, containerId: inspection.Id }
            }
            throw new DockerRuntimeError('startup_failed')
          }
        }
      }
      await delay(100, undefined, { signal })
      inspection = await runtime.inspect()
    }
  }
}
