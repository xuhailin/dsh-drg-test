/** Instance-local Docker fakes cover isolation, startup ownership, and restart behavior. */
import { createServer } from 'node:http'
import type Docker from 'dockerode'
import { describe, expect, it, vi } from 'vitest'
import { DockerRuntimes, type DockerRuntimeBackend, type DockerRuntimeOptions } from '../src/docker.ts'
import type { HostedUserId } from '../src/state.ts'
import { dockerDaemon } from './helpers/docker-daemon.ts'

type Inspection = Awaited<ReturnType<ReturnType<DockerRuntimeBackend['getContainer']>['inspect']>>
type Network = Awaited<ReturnType<ReturnType<DockerRuntimeBackend['getNetwork']>['inspect']>>
type Volume = Awaited<ReturnType<ReturnType<DockerRuntimeBackend['getVolume']>['inspect']>>

const OPTIONS: DockerRuntimeOptions = {
  socketPath: '/unused-docker-test.sock', image: 'local/runtime:test', gatewayContainer: 'gateway-test', gatewayPort: 8080,
  prefix: 'test', memoryBytes: 1024 * 1024 * 1024, nanoCpus: 1_000_000_000,
  pidsLimit: 64, tmpBytes: 1024 * 1024, startupTimeoutMs: 10_000, runtimePort: 3000, maxUsers: 2,
}
const USER = { id: 'a'.repeat(64) as HostedUserId, modelToken: 'scoped-model-credential', origin: 'https://chat.example.test' }
const OTHER = { ...USER, id: 'b'.repeat(64) as HostedUserId, modelToken: 'second-scoped-credential' }

function deferred() {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function blankInspection(name: string, id: string): Inspection {
  return {
    Id: id, Image: 'sha256:runtime-image', Name: `/${name}`,
    Config: { Image: OPTIONS.image, User: '1000:1000', Labels: {}, Env: [], Entrypoint: ['/runtime.sh'], Cmd: null },
    HostConfig: {}, State: { Running: false, Status: 'created', StartedAt: '2026-10-21T00:00:00.000000000Z' },
    Mounts: [], NetworkSettings: { Networks: {} },
  }
}

function fakeDocker(address?: string) {
  const containers = new Map<string, Inspection>()
  const networks = new Map<string, Network>()
  const volumes = new Map<string, Volume>()
  const events: string[] = []
  const created: Docker.ContainerCreateOptions[] = []
  const addresses = new Map<string, string>()
  const gateway = blankInspection('gateway-test', 'gateway-id')
  containers.set('gateway-test', gateway)
  const find = (key: string) => containers.get(key) ?? [...containers.values()].find(value => value.Id === key)
  const absent = (): never => { throw Object.assign(new Error('not found'), { statusCode: 404 }) }
  const requireValue = <T>(value: T | undefined): T => value ?? absent()
  const launch = vi.fn(async (_name: string, _since: string, _signal: AbortSignal): Promise<string | undefined> => 'launch-token')
  const docker: DockerRuntimeBackend = {
    inspectImage: async () => ({ Id: 'sha256:runtime-image', Config: { Entrypoint: ['/runtime.sh'], Cmd: null, Env: ['PATH=/usr/bin'] } }),
    getContainer: key => ({
      inspect: async () => requireValue(find(key)),
      start: async () => {
        const value = requireValue(find(key))
        value.State.Running = true
        value.State.Status = 'running'
        for (const [name, endpoint] of Object.entries(value.NetworkSettings.Networks)) {
          endpoint.NetworkID = requireValue(networks.get(name)).Id
          endpoint.IPAddress = requireValue(addresses.get(value.Id))
        }
        events.push(`start:${value.Name}`)
      },
      launchToken: (since, signal) => launch(key, since, signal),
      remove: async () => {
        const value = requireValue(find(key))
        containers.delete(value.Name.slice(1))
        for (const network of networks.values()) {
          if (network.Containers !== undefined) Reflect.deleteProperty(network.Containers, value.Id)
        }
        events.push(`remove:${value.Name}`)
      },
    }),
    createContainer: vi.fn(async (config: Docker.ContainerCreateOptions) => {
      const name = config.name ?? absent()
      const image = await docker.inspectImage(config.Image ?? '')
      const state = blankInspection(name, `container-${name}`)
      state.Config.Labels = { ...config.Labels }
      state.Config.Env = [...(image.Config.Env ?? []), ...(config.Env ?? [])]
      state.HostConfig = { ...config.HostConfig }
      state.Mounts = (config.HostConfig?.Mounts ?? []).map(value => ({
        Type: value.Type, Name: value.Source, Destination: value.Target, RW: value.ReadOnly !== true,
      }))
      const networkName = config.HostConfig?.NetworkMode ?? absent()
      const network = requireValue(networks.get(networkName))
      state.NetworkSettings.Networks[networkName] = { NetworkID: '', IPAddress: '' }
      addresses.set(state.Id, address ?? `172.28.${String(created.length + 1)}.2`)
      network.Containers ??= {}
      network.Containers[state.Id] = { Name: name }
      containers.set(name, state)
      created.push(config)
      events.push(`create:${name}`)
      return docker.getContainer(name)
    }),
    getNetwork: name => ({
      inspect: async () => requireValue(networks.get(name)),
      connect: async (id) => {
        const network = requireValue(networks.get(name))
        const member = requireValue(find(id))
        member.NetworkSettings.Networks[name] = { NetworkID: network.Id, IPAddress: '172.28.0.1', Aliases: ['gateway'] }
        network.Containers ??= {}
        network.Containers[member.Id] = { Name: member.Name.slice(1), IPv4Address: '172.28.0.1/16' }
        events.push(`connect:${name}`)
      },
      disconnect: async (id) => {
        const member = requireValue(find(id))
        Reflect.deleteProperty(member.NetworkSettings.Networks, name)
        const network = requireValue(networks.get(name))
        if (network.Containers !== undefined) Reflect.deleteProperty(network.Containers, member.Id)
        events.push(`disconnect:${name}`)
      },
      remove: async () => { networks.delete(name); events.push(`network-remove:${name}`) },
    }),
    createNetwork: async (config) => {
      networks.set(config.Name, {
        Id: `network-${config.Name}`, Name: config.Name, Driver: 'bridge', Internal: false,
        Labels: { ...config.Labels }, Options: {}, Containers: {},
      })
      events.push(`network-create:${config.Name}`)
    },
    getVolume: name => ({
      inspect: async () => requireValue(volumes.get(name)),
      remove: async () => { volumes.delete(name); events.push(`volume-remove:${name}`) },
    }),
    createVolume: async (config) => {
      const name = config.Name ?? absent()
      volumes.set(name, { Name: name, Driver: 'local', Labels: { ...config.Labels }, Options: {} })
      events.push(`volume-create:${name}`)
    },
    listContainers: async () => [...containers.values()]
      .filter(value => value !== gateway)
      .map(value => ({ Labels: value.Config.Labels ?? {} })),
  }
  const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth-test=signed-cookie; HttpOnly; Path=/; SameSite=Strict' } }))
  return { docker, request, events, created, containers, networks, volumes, gateway, launch }
}

describe('personal Docker runtimes', () => {
  it('starts a created Docker container before requiring its assigned network ID', async () => {
    const fake = fakeDocker()
    const createContainer = fake.docker.createContainer.bind(fake.docker)
    fake.docker.createContainer = async (options) => {
      const runtime = await createContainer(options)
      const initial = await runtime.inspect()
      expect(initial.State).toMatchObject({ Running: false, Status: 'created' })
      expect(initial.NetworkSettings.Networks[`test-${USER.id}`]).toEqual({ NetworkID: '', IPAddress: '' })
      return runtime
    }
    const owner = new DockerRuntimes(OPTIONS, fake)
    try {
      await expect(owner.ensure(USER)).resolves.toMatchObject({ target: 'http://172.28.1.2:3000' })
      expect(fake.events).toContain(`start:/test-${USER.id}`)
      const inspection = await fake.docker.getContainer(`test-${USER.id}`).inspect()
      expect(inspection.NetworkSettings.Networks[`test-${USER.id}`]?.NetworkID).toBe(`network-test-${USER.id}`)
    } finally { await owner.dispose() }
  })

  it.each(['network assignment', 'privileged mode'] as const)('revalidates %s after starting a new Docker container and rolls it back on mismatch', async (field) => {
    const fake = fakeDocker()
    const getContainer = fake.docker.getContainer.bind(fake.docker)
    fake.docker.getContainer = id => ({
      ...getContainer(id), start: async () => {
        await getContainer(id).start()
        const inspection = await getContainer(id).inspect()
        if (field === 'privileged mode') inspection.HostConfig.Privileged = true
        else {
          const endpoint = inspection.NetworkSettings.Networks[`test-${USER.id}`]
          if (endpoint === undefined) throw new Error('Fixture endpoint is missing')
          endpoint.NetworkID = 'unexpected-network'
        }
      },
    })
    const owner = new DockerRuntimes(OPTIONS, fake)
    try {
      await expect(owner.ensure(USER)).rejects.toMatchObject({ code: 'resource_conflict' })
      expect(fake.request).not.toHaveBeenCalled()
      expect(fake.launch).not.toHaveBeenCalled()
      expect(fake.containers.size).toBe(1)
      expect(fake.networks.size).toBe(0)
      expect(fake.volumes.size).toBe(0)
    } finally { await owner.dispose() }
  })

  it.each([
    { running: true, status: 'running', networkId: 'wrong-network' },
    { running: true, status: 'running', networkId: '' },
    { running: false, status: 'exited', networkId: 'wrong-network' },
    { running: false, status: 'exited', networkId: '' },
    { running: false, status: 'created', networkId: 'wrong-network' },
  ])('preserves an existing $status runtime with an invalid assigned network ID ($networkId)', async ({ running, status, networkId }) => {
    const fake = fakeDocker()
    const owner = new DockerRuntimes(OPTIONS, fake)
    try {
      await owner.ensure(USER)
      const inspection = await fake.docker.getContainer(`test-${USER.id}`).inspect()
      inspection.State.Running = running
      inspection.State.Status = status
      const endpoint = inspection.NetworkSettings.Networks[`test-${USER.id}`]
      if (endpoint === undefined) throw new Error('Fixture endpoint is missing')
      endpoint.NetworkID = networkId
      await expect(owner.ensure(USER)).rejects.toMatchObject({ code: 'resource_conflict' })
      expect(fake.events.filter(event => event.startsWith('start:'))).toHaveLength(1)
      expect(fake.events.some(event => event.includes('remove:'))).toBe(false)
      expect(fake.volumes.size).toBe(1)
    } finally { await owner.dispose() }
  })

  it('provisions and reuses persistent resources through the real dockerode HTTP client', async () => {
    const fake = fakeDocker()
    const daemon = await dockerDaemon(fake.docker)
    const exchange = vi.fn(async () => new Response(null, {
      status: 303, headers: { 'set-cookie': 'dsh-auth-daemon=real-sdk-cookie; Path=/; HttpOnly' },
    }))
    const owner = new DockerRuntimes({ ...OPTIONS, socketPath: daemon.socketPath }, { request: exchange })
    try {
      const first = await owner.ensure(USER)
      expect(first.cookie).toBe('dsh-auth-daemon=real-sdk-cookie')
      expect(await owner.ensure(USER)).toEqual(first)
      expect(fake.created).toHaveLength(1)
      expect(exchange).toHaveBeenCalledWith('http://172.28.1.2:3000/?token=daemon-launch-token', expect.any(Object))
      const listing = daemon.calls.find(call => call.path === '/containers/json')
      expect(JSON.parse(listing?.query.get('filters') ?? '{}')).toEqual({ label: [
        'ai.deepseek.dsh.hosted-workspaces=1', 'ai.deepseek.dsh.hosted-workspaces.instance=test',
      ] })
      const logs = daemon.calls.find(call => call.path.endsWith('/logs'))
      expect(logs?.query.get('follow')).toBe('true')
      expect(logs?.query.get('since')).toBe('1792540800.000000000')
      const connect = daemon.calls.find(call => call.path.endsWith('/connect'))
      expect(JSON.parse(connect?.body ?? '{}')).toMatchObject({ Container: 'gateway-id', EndpointConfig: { Aliases: ['gateway'] } })
      expect(daemon.failures).toEqual([])
    } finally { await owner.dispose() }
  })

  it.each([
    ['2026-10-21T08:54:02.50489327Z', '1792572842.50489327'],
    ['2026-10-21T08:54:02.999999999Z', '1792572842.999999999'],
    ['2026-10-21T08:54:02Z', '1792572842'],
    ['2026-10-21T16:54:02.123456789+08:00', '1792572842.123456789'],
  ])('converts Docker launch time %s to an exact Unix log filter', async (startedAt, expected) => {
    const fake = fakeDocker()
    const create = fake.docker.createContainer.bind(fake.docker)
    fake.docker.createContainer = async (options) => {
      const container = await create(options)
      const inspection = await container.inspect()
      inspection.State.StartedAt = startedAt
      return container
    }
    const daemon = await dockerDaemon(fake.docker)
    const owner = new DockerRuntimes({ ...OPTIONS, socketPath: daemon.socketPath }, { request: fake.request })
    try {
      await owner.ensure(USER)
      const call = daemon.calls.find(value => value.path.endsWith('/logs'))
      expect(call?.query.get('since')).toBe(expected)
      expect(daemon.failures).toEqual([])
    } finally { await owner.dispose() }
  })

  it('excludes an earlier launch token when a restart changes only sub-millisecond precision', async () => {
    const fake = fakeDocker()
    const create = fake.docker.createContainer.bind(fake.docker)
    fake.docker.createContainer = async (options) => {
      const container = await create(options)
      const inspection = await container.inspect()
      inspection.State.StartedAt = '2026-10-21T08:54:02.504893271Z'
      return container
    }
    const daemon = await dockerDaemon(fake.docker, (request, response) => {
      const since = new URL(request.url ?? '/', 'http://docker.test').searchParams.get('since')
      const token = since === '1792572842.504893272' ? 'new-launch' : 'old-launch'
      response.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' })
      response.end(`dsh web: https://chat.example.test/?token=${token}\n`)
    })
    const owner = new DockerRuntimes({ ...OPTIONS, socketPath: daemon.socketPath }, { request: fake.request })
    try {
      await owner.ensure(USER)
      expect(fake.request).toHaveBeenLastCalledWith(expect.stringContaining('token=old-launch'), expect.any(Object))
      const inspection = await fake.docker.getContainer(`test-${USER.id}`).inspect()
      inspection.State.StartedAt = '2026-10-21T08:54:02.504893272Z'
      await owner.ensure(USER)
      expect(fake.request).toHaveBeenLastCalledWith(expect.stringContaining('token=new-launch'), expect.any(Object))
      expect(daemon.calls.filter(call => call.path.endsWith('/logs')).map(call => call.query.get('since')))
        .toEqual(['1792572842.504893271', '1792572842.504893272'])
    } finally { await owner.dispose() }
  })

  it.each(['invalid timestamp', '2026-13-21T08:54:02Z'])('rejects an unusable Docker launch timestamp (%s) without requesting old logs', async (startedAt) => {
    const fake = fakeDocker()
    const create = fake.docker.createContainer.bind(fake.docker)
    fake.docker.createContainer = async (options) => {
      const container = await create(options)
      const inspection = await container.inspect()
      inspection.State.StartedAt = startedAt
      return container
    }
    const daemon = await dockerDaemon(fake.docker)
    const owner = new DockerRuntimes({ ...OPTIONS, socketPath: daemon.socketPath }, { request: fake.request })
    try {
      await expect(owner.ensure(USER)).rejects.toMatchObject({ code: 'startup_failed' })
      expect(daemon.calls.some(call => call.path.endsWith('/logs'))).toBe(false)
      expect(fake.request).not.toHaveBeenCalled()
      expect(fake.containers.size).toBe(1)
      expect(fake.volumes.size).toBe(0)
    } finally { await owner.dispose() }
  })

  it('rolls back daemon-created resources through Docker HTTP in dependency order', async () => {
    const fake = fakeDocker()
    const daemon = await dockerDaemon(fake.docker)
    const owner = new DockerRuntimes({ ...OPTIONS, socketPath: daemon.socketPath }, {
      request: async () => new Response(null, { status: 401 }),
    })
    try {
      await expect(owner.ensure(USER)).rejects.toMatchObject({ code: 'startup_failed' })
      const removed = daemon.calls.filter(call => call.method === 'DELETE' || call.path.endsWith('/disconnect'))
      expect(removed.map(call => call.path)).toEqual([
        `/containers/container-test-${USER.id}`, `/networks/test-${USER.id}/disconnect`,
        `/networks/test-${USER.id}`, `/volumes/test-${USER.id}-home`,
      ])
      expect(removed[0]?.query.get('force')).toBe('true')
      expect(JSON.parse(removed[1]?.body ?? '{}')).toEqual({ Container: 'gateway-id', Force: true })
      expect(fake.containers.size).toBe(1)
      expect(fake.volumes.size).toBe(0)
      expect(daemon.failures).toEqual([])
    } finally { await owner.dispose() }
  })

  it('retries a completed Docker log response that contains no launch token', async () => {
    const fake = fakeDocker()
    const daemon = await dockerDaemon(fake.docker, (_request, response, attempt) => {
      response.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' })
      response.end(attempt === 1 ? 'runtime is preparing\n' : 'dsh web: https://chat.example.test/?token=next-log-token\n')
    })
    const owner = new DockerRuntimes({ ...OPTIONS, socketPath: daemon.socketPath }, { request: fake.request })
    try {
      await expect(owner.ensure(USER)).resolves.toMatchObject({ cookie: 'dsh-auth-test=signed-cookie' })
      expect(daemon.calls.filter(call => call.path.endsWith('/logs'))).toHaveLength(2)
      expect(fake.request).toHaveBeenCalledWith(expect.stringContaining('token=next-log-token'), expect.any(Object))
      expect(daemon.failures).toEqual([])
    } finally { await owner.dispose() }
  })

  it('aborts a Docker log response acquired after gateway disposal began', async () => {
    const fake = fakeDocker()
    const requested = deferred()
    let reply: (() => void) | undefined
    const daemon = await dockerDaemon(fake.docker, (_request, response) => {
      reply = () => {
        reply = undefined
        response.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' })
        response.write('preparing\n')
      }
      requested.resolve()
    })
    const owner = new DockerRuntimes({ ...OPTIONS, socketPath: daemon.socketPath }, { request: fake.request })
    const startup = owner.ensure(USER)
    const rejected = expect(startup).rejects.toMatchObject({ code: 'disposed' })
    try {
      await requested.promise
      const disposed = owner.dispose()
      reply?.()
      await Promise.all([disposed, rejected])
      expect(fake.containers.size).toBe(1)
      expect(fake.networks.size).toBe(0)
      expect(fake.volumes.size).toBe(0)
      expect(daemon.failures).toEqual([])
    } finally { reply?.(); await owner.dispose() }
  })

  it('binds the real HTTP exchange to the public host rather than the private address', async () => {
    let observedHost: string | undefined
    let observedPath: string | undefined
    const server = createServer((request, response) => {
      observedHost = request.headers.host
      observedPath = request.url
      response.writeHead(303, { 'set-cookie': 'dsh-auth-real=authority-signed; Path=/; HttpOnly' })
      response.end()
    })
    let owner: DockerRuntimes | undefined
    try {
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('server has no TCP address')
      const fake = fakeDocker('127.0.0.1')
      owner = new DockerRuntimes({ ...OPTIONS, runtimePort: address.port }, { docker: fake.docker })
      const result = await owner.ensure({ ...USER, origin: 'https://chat.example.test:9443' })
      expect(observedHost).toBe('chat.example.test:9443')
      expect(observedPath).toBe('/?token=launch-token')
      expect(result.cookie).toBe('dsh-auth-real=authority-signed')
    } finally {
      await owner?.dispose()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    }
  })

  it.each(['connection reset', 'truncated body', 'invalid status'] as const)('retries a real HTTP launch exchange after %s', async (fault) => {
    let attempts = 0
    const server = createServer((request, response) => {
      attempts++
      if (attempts === 1) {
        if (fault === 'connection reset') { request.socket.destroy(); return }
        if (fault === 'invalid status') { response.writeHead(700).end(); return }
        response.writeHead(303, { 'content-length': '100', 'set-cookie': 'dsh-auth-partial=untrusted; Path=/' })
        response.flushHeaders()
        response.write('partial')
        response.socket?.end()
        return
      }
      response.writeHead(303, { 'set-cookie': 'dsh-auth-retry=confirmed; Path=/; HttpOnly' }).end()
    })
    let owner: DockerRuntimes | undefined
    try {
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('server has no TCP address')
      owner = new DockerRuntimes({ ...OPTIONS, runtimePort: address.port }, { docker: fakeDocker('127.0.0.1').docker })
      await expect(owner.ensure(USER)).resolves.toMatchObject({ cookie: 'dsh-auth-retry=confirmed' })
      expect(attempts).toBe(2)
    } finally {
      await owner?.dispose()
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
      server.closeAllConnections()
      await closed
    }
  })

  it('rejects a completed real HTTP launch response without an authentication cookie', async () => {
    const server = createServer((_request, response) => { response.writeHead(303).end() })
    let owner: DockerRuntimes | undefined
    try {
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('server has no TCP address')
      owner = new DockerRuntimes({ ...OPTIONS, runtimePort: address.port }, { docker: fakeDocker('127.0.0.1').docker })
      await expect(owner.ensure(USER)).rejects.toMatchObject({ code: 'startup_failed' })
    } finally {
      await owner?.dispose()
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
      server.closeAllConnections()
      await closed
    }
  })

  it('applies resource limits and private storage/network while keeping credentials server-side', async () => {
    const fake = fakeDocker()
    const owner = new DockerRuntimes(OPTIONS, fake)
    try {
      const result = await owner.ensure(USER)
      expect(result).toEqual({ target: 'http://172.28.1.2:3000', cookie: 'dsh-auth-test=signed-cookie', containerId: `container-test-${USER.id}` })
      const config = fake.created[0]
      expect(config).toMatchObject({ Image: OPTIONS.image, User: '1000:1000', HostConfig: {
        NetworkMode: `test-${USER.id}`, ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'], Init: true, Memory: OPTIONS.memoryBytes, NanoCpus: OPTIONS.nanoCpus,
        PidsLimit: OPTIONS.pidsLimit, Mounts: [{ Type: 'volume', Source: `test-${USER.id}-home`, Target: '/home/node', ReadOnly: false }],
        Tmpfs: { '/tmp': `rw,nosuid,nodev,size=${String(OPTIONS.tmpBytes)},mode=1777` },
      } })
      expect(config?.Cmd).toBeUndefined()
      expect(config?.Entrypoint).toBeUndefined()
      expect(config?.HostConfig?.PortBindings).toBeUndefined()
      expect(config?.Env).toEqual([
        'HOME=/home/node', 'DSH_HOME=/home/node/.dsh', 'DSH_AGENTS_HOME=/home/node/.agents',
        `DEEPSEEK_API_KEY=${USER.modelToken}`, 'DEEPSEEK_BASE_URL=http://gateway:8080/model',
        `HOSTED_PUBLIC_URL=${USER.origin}`, 'HOSTED_RUNTIME_PORT=3000',
      ])
      expect(fake.request).toHaveBeenCalledWith('http://172.28.1.2:3000/?token=launch-token', expect.objectContaining({
        redirect: 'manual', headers: { host: 'chat.example.test' },
      }))
      expect(fake.launch).toHaveBeenCalledWith(`test-${USER.id}`, '2026-10-21T00:00:00.000000000Z', expect.any(AbortSignal))
      expect(fake.gateway.NetworkSettings.Networks[`test-${USER.id}`]?.Aliases).toEqual(['gateway'])
    } finally { await owner.dispose() }
    expect(fake.volumes.size).toBe(1)
    expect(fake.networks.size).toBe(1)
    expect(fake.events.some(value => value.includes('remove:'))).toBe(false)
  })

  it('shares one in-flight startup for simultaneous requests from the same user', async () => {
    const fake = fakeDocker()
    const reached = deferred()
    const release = deferred()
    fake.launch.mockImplementation(async () => { reached.resolve(); await release.promise; return 'launch-token' })
    const owner = new DockerRuntimes(OPTIONS, fake)
    try {
      const first = owner.ensure(USER)
      await reached.promise
      const second = owner.ensure(USER)
      expect(second).toBe(first)
      expect(fake.created).toHaveLength(1)
      release.resolve()
      expect(await second).toEqual(await first)
    } finally { release.resolve(); await owner.dispose() }
  })

  it('binds the per-network model listener before starting a runtime and on reuse', async () => {
    const fake = fakeDocker()
    const onNetwork = vi.fn(async (address: string) => { fake.events.push(`listener:${address}`) })
    const owner = new DockerRuntimes(OPTIONS, { ...fake, onNetwork })
    try {
      await owner.ensure(USER)
      expect(onNetwork).toHaveBeenCalledWith('172.28.0.1')
      expect(fake.events.indexOf('listener:172.28.0.1')).toBeLessThan(fake.events.indexOf(`start:/test-${USER.id}`))
      await owner.ensure(USER)
      expect(onNetwork).toHaveBeenCalledTimes(2)
    } finally { await owner.dispose() }
  })

  it('rolls back newly acquired Docker resources when binding the model listener fails', async () => {
    const fake = fakeDocker()
    const owner = new DockerRuntimes(OPTIONS, {
      ...fake, onNetwork: async () => { throw new Error('listener unavailable') },
    })
    try {
      await expect(owner.ensure(USER)).rejects.toMatchObject({ code: 'startup_failed' })
      expect(fake.created).toHaveLength(0)
      expect(fake.networks.size).toBe(0)
      expect(fake.volumes.size).toBe(0)
      expect(fake.containers.size).toBe(1)
      expect(Object.keys(fake.gateway.NetworkSettings.Networks)).toHaveLength(0)
    } finally { await owner.dispose() }
  })

  it('gives different users separate networks, volumes, addresses, and credentials', async () => {
    const fake = fakeDocker()
    const owner = new DockerRuntimes(OPTIONS, fake)
    try {
      const [first, second] = await Promise.all([owner.ensure(USER), owner.ensure(OTHER)])
      expect(first.target).not.toBe(second.target)
      expect(fake.networks.size).toBe(2)
      expect(fake.volumes.size).toBe(2)
      for (const config of fake.created) {
        const value = fake.containers.get(config.name ?? '')
        expect(Object.keys(value?.NetworkSettings.Networks ?? {})).toEqual([config.name])
        expect(Object.keys(fake.networks.get(config.name ?? '')?.Containers ?? {})).toHaveLength(2)
      }
      expect(fake.created[0]?.Env).not.toContain(`DEEPSEEK_API_KEY=${OTHER.modelToken}`)
      expect(fake.created[1]?.Env).not.toContain(`DEEPSEEK_API_KEY=${USER.modelToken}`)
    } finally { await owner.dispose() }
  })

  it('reserves capacity before concurrent new users can create containers', async () => {
    const fake = fakeDocker()
    const reached = deferred()
    const release = deferred()
    fake.launch.mockImplementation(async () => { reached.resolve(); await release.promise; return 'launch-token' })
    const owner = new DockerRuntimes({ ...OPTIONS, maxUsers: 1 }, fake)
    const first = owner.ensure(USER)
    try {
      await reached.promise
      await expect(owner.ensure(OTHER)).rejects.toMatchObject({ code: 'capacity' })
      expect(fake.created).toHaveLength(1)
      release.resolve()
      await first
      await owner.ensure(USER)
      expect(fake.created).toHaveLength(1)
    } finally { release.resolve(); await owner.dispose() }
  })

  it('reattaches the gateway after restart and reuses persistent runtime resources', async () => {
    const fake = fakeDocker()
    const first = new DockerRuntimes(OPTIONS, fake)
    const expected = await first.ensure(USER)
    await first.dispose()
    const name = `test-${USER.id}`
    Reflect.deleteProperty(fake.gateway.NetworkSettings.Networks, name)
    const network = fake.networks.get(name)
    if (network?.Containers !== undefined) Reflect.deleteProperty(network.Containers, fake.gateway.Id)
    const second = new DockerRuntimes(OPTIONS, fake)
    try {
      expect(await second.ensure(USER)).toEqual(expected)
      expect(fake.created).toHaveLength(1)
      expect(fake.events.filter(value => value.startsWith('connect:'))).toHaveLength(2)
      expect(fake.events.filter(value => value.startsWith('start:'))).toHaveLength(1)
    } finally { await second.dispose() }
  })

  it.each([
    ['foreign labels', (value: Inspection) => { value.Config.Labels = {} }],
    ['changed model credential', (value: Inspection) => { value.Config.Env?.push('DEEPSEEK_API_KEY=other') }],
    ['changed image', (value: Inspection) => { value.Image = 'sha256:other-image' }],
    ['changed entrypoint', (value: Inspection) => { value.Config.Entrypoint = ['/other.sh'] }],
    ['writable root', (value: Inspection) => { value.HostConfig.ReadonlyRootfs = false }],
    ['privileged mode', (value: Inspection) => { value.HostConfig.Privileged = true }],
    ['published port', (value: Inspection) => { value.HostConfig.PortBindings = { '3000/tcp': [{ HostPort: '3000' }] } }],
    ['host PID namespace', (value: Inspection) => { value.HostConfig.PidMode = 'host' }],
    ['host mount', (value: Inspection) => { value.Mounts.push({ Type: 'bind', Destination: '/host', RW: true }) }],
    ['shared network', (value: Inspection) => { value.NetworkSettings.Networks.shared = { NetworkID: 'shared', IPAddress: '172.30.0.2' } }],
  ])('rejects an existing runtime with %s without removing persistent data', async (_name, mutate) => {
    const fake = fakeDocker()
    const owner = new DockerRuntimes(OPTIONS, fake)
    try {
      await owner.ensure(USER)
      const runtime = fake.containers.get(`test-${USER.id}`)
      if (runtime === undefined) throw new Error('missing runtime')
      mutate(runtime)
      await expect(owner.ensure(USER)).rejects.toMatchObject({ code: 'resource_conflict' })
      expect(fake.volumes.size).toBe(1)
      expect(fake.containers.size).toBe(2)
      expect(fake.events.some(value => value.includes('remove:'))).toBe(false)
    } finally { await owner.dispose() }
  })

  it('rejects foreign network members before connecting the gateway', async () => {
    const fake = fakeDocker()
    const owner = new DockerRuntimes(OPTIONS, fake)
    try {
      await owner.ensure(USER)
      const network = fake.networks.get(`test-${USER.id}`)
      if (network === undefined) throw new Error('missing network')
      network.Containers = { ...network.Containers, intruder: { Name: 'another-user' } }
      await expect(owner.ensure(USER)).rejects.toMatchObject({ code: 'resource_conflict' })
      expect(fake.events.filter(value => value.startsWith('connect:'))).toHaveLength(1)
    } finally { await owner.dispose() }
  })

  it.each(['volume', 'network'] as const)('preserves a foreign preexisting %s with the expected name', async (resource) => {
    const fake = fakeDocker()
    const name = `test-${USER.id}`
    if (resource === 'volume') fake.volumes.set(`${name}-home`, { Name: `${name}-home`, Driver: 'local', Labels: { owner: 'someone-else' } })
    else fake.networks.set(name, { Id: 'foreign-network', Name: name, Driver: 'bridge', Internal: false, Labels: { owner: 'someone-else' } })
    const owner = new DockerRuntimes(OPTIONS, fake)
    try {
      await expect(owner.ensure(USER)).rejects.toMatchObject({ code: 'resource_conflict' })
      expect(fake.created).toHaveLength(0)
      if (resource === 'volume') expect(fake.volumes.get(`${name}-home`)?.Labels).toEqual({ owner: 'someone-else' })
      else expect(fake.networks.get(name)?.Labels).toEqual({ owner: 'someone-else' })
      expect(fake.events).not.toContain(`${resource}-remove:${resource === 'volume' ? `${name}-home` : name}`)
    } finally { await owner.dispose() }
  })

  it('preserves a foreign volume returned by a concurrent Docker create', async () => {
    const fake = fakeDocker()
    fake.docker.createVolume = async (config) => {
      const name = config.Name ?? ''
      fake.volumes.set(name, { Name: name, Driver: 'local', Labels: { owner: 'someone-else' } })
    }
    const owner = new DockerRuntimes(OPTIONS, fake)
    try {
      await expect(owner.ensure(USER)).rejects.toMatchObject({ code: 'resource_conflict' })
      expect(fake.volumes.get(`test-${USER.id}-home`)?.Labels).toEqual({ owner: 'someone-else' })
      expect(fake.events.some(value => value.includes('remove:'))).toBe(false)
    } finally { await owner.dispose() }
  })

  it('removes newly created resources in consumer-before-dependency order on startup failure', async () => {
    const fake = fakeDocker()
    fake.request.mockResolvedValue(new Response(null, { status: 401 }))
    const owner = new DockerRuntimes(OPTIONS, fake)
    try {
      await expect(owner.ensure(USER)).rejects.toMatchObject({ code: 'startup_failed' })
      expect(fake.containers.size).toBe(1)
      expect(fake.networks.size).toBe(0)
      expect(fake.volumes.size).toBe(0)
      const name = `test-${USER.id}`
      expect(fake.events.slice(-4)).toEqual([`remove:/${name}`, `disconnect:${name}`, `network-remove:${name}`, `volume-remove:${name}-home`])
    } finally { await owner.dispose() }
  })

  it('waits for readiness state and retries a refused connection', async () => {
    const fake = fakeDocker()
    fake.request.mockRejectedValueOnce(new TypeError('connection refused'))
    const owner = new DockerRuntimes(OPTIONS, fake)
    try {
      await expect(owner.ensure(USER)).resolves.toMatchObject({ cookie: 'dsh-auth-test=signed-cookie' })
      expect(fake.request).toHaveBeenCalledTimes(2)
      expect(fake.created).toHaveLength(1)
    } finally { await owner.dispose() }
  })

  it('reports Docker inspection failures without treating them as absent resources', async () => {
    const fake = fakeDocker()
    const getVolume = fake.docker.getVolume.bind(fake.docker)
    fake.docker.getVolume = name => ({
      ...getVolume(name), inspect: async () => { throw Object.assign(new Error('private daemon detail'), { statusCode: 503 }) },
    })
    const owner = new DockerRuntimes(OPTIONS, fake)
    try {
      await expect(owner.ensure(USER)).rejects.toMatchObject({ code: 'docker_unavailable', message: 'Personal runtime operation failed (docker_unavailable).' })
      expect(fake.created).toHaveLength(0)
      expect(fake.volumes.size).toBe(0)
    } finally { await owner.dispose() }
  })

  it('accepts Docker responses that omit optional empty network, volume and image fields', async () => {
    const fake = fakeDocker()
    const createVolume = fake.docker.createVolume.bind(fake.docker)
    const createNetwork = fake.docker.createNetwork.bind(fake.docker)
    fake.docker.createVolume = async (options) => {
      await createVolume(options)
      const value = fake.volumes.get(options.Name ?? '')
      if (value === undefined) throw new Error('Fixture volume is missing')
      value.Options = null
    }
    fake.docker.createNetwork = async (options) => {
      await createNetwork(options)
      const value = fake.networks.get(options.Name)
      if (value === undefined) throw new Error('Fixture network is missing')
      value.Options = null
      Reflect.deleteProperty(value, 'Containers')
    }
    fake.docker.inspectImage = async () => ({ Id: 'sha256:runtime-image', Config: { Entrypoint: ['/runtime.sh'], Cmd: null, Env: null } })
    const owner = new DockerRuntimes(OPTIONS, fake)
    try {
      await expect(owner.ensure(USER)).resolves.toMatchObject({ cookie: 'dsh-auth-test=signed-cookie' })
      expect(fake.created).toHaveLength(1)
    } finally { await owner.dispose() }
  })

  it('rejects a runtime that exits immediately after Docker starts it', async () => {
    const fake = fakeDocker()
    const getContainer = fake.docker.getContainer.bind(fake.docker)
    fake.docker.getContainer = id => ({
      ...getContainer(id), start: async () => {
        await getContainer(id).start()
        const value = await getContainer(id).inspect()
        value.State.Running = false
        value.State.Status = 'exited'
      },
    })
    const owner = new DockerRuntimes(OPTIONS, fake)
    try {
      await expect(owner.ensure(USER)).rejects.toMatchObject({ code: 'startup_failed' })
      expect(fake.launch).not.toHaveBeenCalled()
      expect(fake.volumes.size).toBe(0)
    } finally { await owner.dispose() }
  })

  it('waits for Docker to assign an IPv4 address before exchanging the launch token', async () => {
    const fake = fakeDocker('')
    const getContainer = fake.docker.getContainer.bind(fake.docker)
    let runningReads = 0
    fake.docker.getContainer = id => ({
      ...getContainer(id), inspect: async () => {
        const value = await getContainer(id).inspect()
        if (value.State.Running && value.Name === `/test-${USER.id}`) {
          runningReads++
          const endpoint = value.NetworkSettings.Networks[`test-${USER.id}`]
          if (endpoint === undefined) throw new Error('Fixture network endpoint is missing')
          if (runningReads > 1) endpoint.IPAddress = '172.28.1.2'
        }
        return value
      },
    })
    const owner = new DockerRuntimes(OPTIONS, fake)
    try {
      await expect(owner.ensure(USER)).resolves.toMatchObject({ target: 'http://172.28.1.2:3000' })
      expect(runningReads).toBe(2)
      expect(fake.request).toHaveBeenCalledTimes(1)
    } finally { await owner.dispose() }
  })

  it('retains dependencies and reports unknown cleanup state when container removal fails', async () => {
    const fake = fakeDocker()
    fake.request.mockResolvedValue(new Response(null, { status: 401 }))
    const getContainer = fake.docker.getContainer.bind(fake.docker)
    fake.docker.getContainer = id => ({ ...getContainer(id), remove: async () => { throw new Error('Docker unavailable') } })
    const owner = new DockerRuntimes(OPTIONS, fake)
    try {
      await expect(owner.ensure(USER)).rejects.toMatchObject({ code: 'cleanup_failed' })
      expect(fake.containers.size).toBe(2)
      expect(fake.networks.size).toBe(1)
      expect(fake.volumes.size).toBe(1)
      expect(fake.events.some(value => value.startsWith('disconnect:'))).toBe(false)
    } finally { await owner.dispose() }
  })

  it('reports startup deadlines without exposing a launch token or request diagnostics', async () => {
    const fake = fakeDocker()
    fake.request.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted === true) { reject(new Error('aborted')); return }
      signal?.addEventListener('abort', () => { reject(new Error('credential-bearing upstream diagnostic')) }, { once: true })
    }))
    const owner = new DockerRuntimes({ ...OPTIONS, startupTimeoutMs: 10 }, fake)
    try {
      await expect(owner.ensure(USER)).rejects.toMatchObject({ code: 'startup_timeout', message: 'Personal runtime operation failed (startup_timeout).' })
      expect(fake.containers.size).toBe(1)
      expect(fake.volumes.size).toBe(0)
    } finally { await owner.dispose() }
  })

  it('disposal waits for in-flight startup and rollback and retains established users', async () => {
    const fake = fakeDocker()
    const owner = new DockerRuntimes(OPTIONS, fake)
    await owner.ensure(USER)
    const entered = deferred()
    const release = deferred()
    fake.launch.mockImplementation(async (_name, _since, signal) => {
      entered.resolve()
      await release.promise
      signal.throwIfAborted()
      return 'launch-token'
    })
    const pending = owner.ensure(OTHER)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'disposed' })
    await entered.promise
    const disposed = owner.dispose()
    expect(fake.containers.size).toBe(3)
    release.resolve()
    await Promise.all([disposed, rejected])
    expect(fake.containers.size).toBe(2)
    expect(fake.volumes.size).toBe(1)
    expect(fake.containers.get(`test-${USER.id}`)?.State.Running).toBe(true)
    await expect(owner.ensure(USER)).rejects.toMatchObject({ code: 'disposed' })
  })
})
