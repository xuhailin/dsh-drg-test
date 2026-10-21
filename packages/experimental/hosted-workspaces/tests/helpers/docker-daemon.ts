/** Private HTTP socket fixture for exercising dockerode's real request and streaming paths. */
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { text } from 'node:stream/consumers'
import type Docker from 'dockerode'
import { onTestFinished } from 'vitest'
import type { DockerRuntimeBackend } from '../../src/docker.ts'

interface Call { method: string | undefined; path: string; query: URLSearchParams; body: string }
type Logs = (request: IncomingMessage, response: ServerResponse, attempt: number) => void

/**
 * Bind an atomically allocated private daemon socket and register complete teardown.
 * @param backend - Instance-local resource state behind the Docker HTTP operations.
 * @param logs - Optional response owner for startup-log fault and cancellation scenarios.
 * @returns Socket path, recorded requests and fixture failures.
 */
export async function dockerDaemon(backend: DockerRuntimeBackend, logs?: Logs) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-dockerd-'))
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\${basename(directory)}` : join(directory, 'docker.sock')
  const calls: Call[] = []
  const failures: unknown[] = []
  let logAttempt = 0
  function json(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(value))
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://docker.test')
    const path = decodeURIComponent(url.pathname.replace(/^\/v\d+\.\d+/u, ''))
    const body = await text(request)
    calls.push({ method: request.method, path, query: url.searchParams, body })
    if (path === '/containers/json') {  json(response, 200, await backend.listContainers()); return }
    if (path.startsWith('/images/') && path.endsWith('/json')) {
      json(response, 200, await backend.inspectImage(path.slice('/images/'.length, -'/json'.length))); return
    }
    if (path === '/volumes/create') {
      const options = JSON.parse(body) as Docker.VolumeCreateOptions
      await backend.createVolume(options)
      json(response, 201, await backend.getVolume(options.Name ?? '').inspect()); return
    }
    if (path.startsWith('/volumes/')) {
      const volume = backend.getVolume(path.slice('/volumes/'.length))
      if (request.method === 'DELETE') { await volume.remove(); response.writeHead(204).end(); return }
      json(response, 200, await volume.inspect()); return
    }
    if (path === '/networks/create') {
      const options = JSON.parse(body) as Docker.NetworkCreateOptions
      await backend.createNetwork(options)
      json(response, 201, { Id: options.Name, Warning: '' }); return
    }
    if (path.startsWith('/networks/')) {
      const [name, operation] = path.slice('/networks/'.length).split('/')
      const network = backend.getNetwork(name ?? '')
      if (operation === 'connect' || operation === 'disconnect') {
        const options = JSON.parse(body) as { Container: string }
        if (operation === 'connect') await network.connect(options.Container)
        else await network.disconnect(options.Container)
        response.writeHead(200).end()
        return
      }
      if (request.method === 'DELETE') { await network.remove(); response.writeHead(204).end(); return }
      json(response, 200, await network.inspect()); return
    }
    if (path === '/containers/create') {
      const options = JSON.parse(body) as Docker.ContainerCreateOptions
      const container = await backend.createContainer({ ...options, name: url.searchParams.get('name') ?? '' })
      json(response, 201, { Id: (await container.inspect()).Id, Warnings: [] }); return
    }
    if (path.startsWith('/containers/')) {
      const [id, operation] = path.slice('/containers/'.length).split('/')
      const container = backend.getContainer(id ?? '')
      if (operation === 'json') {  json(response, 200, await container.inspect()); return }
      if (operation === 'start') { await container.start(); response.writeHead(204).end(); return }
      if (operation === 'logs') {
        logAttempt++
        if (logs !== undefined) {  logs(request, response, logAttempt); return }
        response.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' })
        // A large unfinished line exercises bounded log retention across HTTP chunks.
        response.write('x'.repeat(131_072))
        response.end('\ndsh web: https://chat.example.test/?token=daemon-launch-token\n')
        return
      }
      if (request.method === 'DELETE') { await container.remove(); response.writeHead(204).end(); return }
    }
    throw new Error(`Unexpected Docker fixture operation: ${request.method} ${path}`)
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const status = error !== null && typeof error === 'object' && 'statusCode' in error ? error.statusCode : 500
      if (status !== 404) failures.push(error)
      json(response, status === 404 ? 404 : 500, { message: status === 404 ? 'Resource does not exist' : 'Fixture operation failed' })
    })
  })
  onTestFinished(async () => {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    server.closeAllConnections()
    await closed
    await rm(directory, { recursive: true, force: true })
  })
  server.listen(socketPath)
  await once(server, 'listening')
  return { socketPath, calls, failures }
}
