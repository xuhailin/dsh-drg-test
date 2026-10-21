/** Real ephemeral HTTP peers verify proxy streaming, credentials, bounds, and teardown. */
import { ClientRequest, createServer, request as httpRequest, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { WorkspaceProxy, type RuntimeBinding } from '../src/proxy.ts'

function deferred() {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function listening(server: Server): Promise<string> {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing bound TCP address')
  return `http://127.0.0.1:${String(address.port)}`
}

async function fixture(handler: RequestListener, limit = 16 * 1024) {
  const sockets = new Set<Socket>()
  const track = (server: Server): void => {
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
  }
  const upstream = createServer(handler)
  track(upstream)
  const proxy = new WorkspaceProxy(limit)
  let binding: RuntimeBinding
  const front = createServer((req, res) => {
    void proxy.request(req, res, binding).catch(() => { res.writeHead(503); res.end() })
  })
  front.on('upgrade', (req, socket, head) => { proxy.upgrade(req, socket, head, binding) })
  track(front)
  try {
    const target = await listening(upstream)
    binding = { target, cookie: 'dsh-auth-private=backend-only', origin: 'https://u-user.chat.example.test:9443', name: '<script>bad&"label</script>' }
    const url = await listening(front)
    return {
      url, upstream, proxy, binding, front,
      close: async () => {
        await proxy.dispose()
        for (const socket of sockets) socket.destroy()
        await Promise.all([front, upstream].map(server => new Promise<void>((resolve, reject) => {
          if (!server.listening) { resolve(); return }
          server.close((error) => {
            if (error === undefined) resolve()
            else reject(error)
          })
        })))
      },
    }
  } catch (error) {
    await proxy.dispose()
    for (const socket of sockets) socket.destroy()
    front.close()
    upstream.close()
    throw error
  }
}

const HTML = '<!doctype html><html><body><main>DSH content</main></body></html>'

describe('private workspace proxy', () => {
  it('disposes before the first request without waiting for an unused proxy listener', async () => {
    const proxy = new WorkspaceProxy(1024)
    await proxy.dispose()
    await proxy.dispose()
  })

  it('refuses HTTP and upgrade admission after disposal', async () => {
    const server = await fixture((_req, res) => { res.end('unused') })
    try {
      await server.proxy.dispose()
      expect((await fetch(server.url)).status).toBe(503)
      await expect(new Promise<void>((resolve, reject) => {
        const request = httpRequest(server.url, { headers: { connection: 'Upgrade', upgrade: 'websocket' } })
        request.once('error', reject)
        request.once('response', () => { resolve() })
        request.end()
      })).rejects.toBeInstanceOf(Error)
    } finally { await server.close() }
  })

  it('destroys an unsupported Duplex carrier instead of starting a WebSocket transport', async () => {
    const carrier = new PassThrough()
    const server = await fixture((_req, res) => { res.end('ok') })
    server.front.prependListener('request', (req) => { server.proxy.upgrade(req, carrier, Buffer.alloc(0), server.binding) })
    try {
      expect((await fetch(`${server.url}/asset`)).status).toBe(200)
      expect(carrier.destroyed).toBe(true)
    } finally { carrier.destroy(); await server.close() }
  })

  it('contains refused HTTP and WebSocket connections without leaking the backend credential', async () => {
    const server = await fixture((_req, res) => { res.end('unused') })
    await new Promise<void>((resolve) => { server.upstream.close(() => { resolve() }) })
    server.front.prependListener('request', (_req, res) => { res.setHeader('set-cookie', 'other-layer=hidden') })
    try {
      const response = await fetch(server.url)
      expect(response.status).toBe(502)
      expect(await response.text()).not.toContain('backend-only')
      await expect(new Promise<void>((resolve, reject) => {
        const request = httpRequest(`${server.url}/socket`, { headers: { connection: 'Upgrade', upgrade: 'websocket' } })
        request.once('error', reject)
        request.once('response', () => { resolve() })
        request.end()
      })).rejects.toBeInstanceOf(Error)
    } finally { await server.close() }
  })

  it('forwards index HEAD responses and non-HTML responses without a decoding buffer', async () => {
    const server = await fixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': 10, 'set-cookie': 'secret=hidden' })
      res.end('0123456789')
    }, 1)
    try {
      const response = await fetch(`${server.url}/index.html`, { method: 'HEAD' })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('')
      expect(response.headers.get('set-cookie')).toBeNull()
    } finally { await server.close() }
    const binary = await fixture((_req, res) => { res.writeHead(200); res.end('raw') }, 1)
    try {
      const response = await fetch(binary.url)
      expect(await response.text()).toBe('raw')
    } finally { await binary.close() }
  })

  it('removes stale compression metadata when an index omits an encoding header', async () => {
    const server = await fixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', etag: 'stale', 'content-md5': 'stale', 'set-cookie2': 'hidden=value' })
      res.end(HTML)
    })
    try {
      const response = await fetch(`${server.url}/index.html`)
      expect(response.status).toBe(200)
      await response.text()
      expect(response.headers.get('etag')).toBeNull()
      expect(response.headers.get('content-md5')).toBeNull()
      expect(response.headers.get('set-cookie2')).toBeNull()
    } finally { await server.close() }
  })

  it('contains an upstream transport failure after a streaming response has begun', async () => {
    const server = await fixture((_req, res) => { res.writeHead(200); res.write('partial') })
    try {
      const response = await fetch(`${server.url}/stream`)
      const request = [...server.proxy['transports'].keys()].find(value => value instanceof ClientRequest)
      if (!(request instanceof ClientRequest)) throw new Error('missing upstream request')
      const body = response.text()
      request.emit('error', new Error('upstream transport failed'))
      await expect(body).rejects.toBeInstanceOf(Error)
    } finally { await server.close() }
  })

  it('aborts an index reader and its decoder when the browser closes before the document finishes', async () => {
    const waiting = deferred()
    const server = await fixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
      res.write(gzipSync(HTML).subarray(0, 10))
      waiting.resolve()
    })
    const reading = deferred()
    const readIndex = server.proxy['indexResponse'].bind(server.proxy)
    server.proxy['indexResponse'] = (upstream: IncomingMessage, req: IncomingMessage, res: ServerResponse) => {
      const task = readIndex(upstream, req, res)
      reading.resolve()
      return task
    }
    const controller = new AbortController()
    try {
      const response = fetch(server.url, { signal: controller.signal })
      const failed = expect(response).rejects.toBeInstanceOf(Error)
      await waiting.promise
      await reading.promise
      controller.abort()
      await failed
      await server.proxy.dispose()
    } finally { controller.abort(); await server.close() }
  })

  it('settles transport creation that overlaps proxy disposal', async () => {
    const server = await fixture((_req, res) => { res.end('unused') })
    server.front.on('request', () => { void server.proxy.dispose() })
    try {
      await expect(fetch(server.url)).rejects.toBeInstanceOf(Error)
      await server.proxy.dispose()
    } finally { await server.close() }
  })

  it.each([
    ['identity', (value: string) => Buffer.from(value)],
    ['gzip', (value: string) => gzipSync(value)],
    ['deflate', (value: string) => deflateSync(value)],
    ['br', (value: string) => brotliCompressSync(value)],
  ])('bounds and decodes %s HTML and escapes the authenticated logout label', async (encoding, compress) => {
    const server = await fixture((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'content-encoding': encoding,
        'set-cookie': 'upstream-secret=hidden', 'referrer-policy': 'no-referrer',
      })
      res.end(compress(HTML))
    })
    try {
      const response = await fetch(server.url, { headers: { 'accept-language': 'zh-CN' } })
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(body).toContain('<main>DSH content</main>')
      expect(body).toContain('action="/auth/logout"')
      expect(body).toContain('退出登录')
      expect(body).toContain('&lt;script&gt;bad&amp;&quot;label&lt;/script&gt;')
      expect(body).not.toContain('<script>bad')
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(response.headers.get('content-encoding')).toBeNull()
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('referrer-policy')).toBe('same-origin')
      expect(Number(response.headers.get('content-length'))).toBe(Buffer.byteLength(body))
    } finally { await server.close() }
  })

  it('replaces browser credentials and spoofed proxy identity while preserving public Host and Origin', async () => {
    let received: IncomingMessage['headers'] = {}
    const server = await fixture((req, res) => {
      received = req.headers
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'private-upstream=hidden' })
      res.end('{}')
    })
    try {
      const response = await fetch(`${server.url}/rpc`, { headers: {
        cookie: 'dsh-sso=private-sso; another=secret', authorization: 'Bearer external-secret',
        origin: server.binding.origin, 'x-forwarded-for': 'spoof', 'x-forwarded-user': 'spoof', forwarded: 'spoof',
        'x-real-ip': 'spoof', 'x-dsh-auth-token': 'spoof', 'x-user-id': 'spoof', 'x-auth-request-user': 'spoof',
        'proxy-authorization': 'spoof', 'remote-user': 'spoof', 'x-proxy-identity': 'spoof', 'x-identity-user': 'spoof',
      } })
      await response.text()
      expect(received.cookie).toBe(server.binding.cookie)
      expect(received.host).toBe('u-user.chat.example.test:9443')
      expect(received.origin).toBe(server.binding.origin)
      for (const key of ['authorization', 'x-forwarded-for', 'x-forwarded-user', 'forwarded', 'x-real-ip',
        'x-dsh-auth-token', 'x-user-id', 'x-auth-request-user', 'proxy-authorization', 'remote-user', 'x-proxy-identity', 'x-identity-user']) {
        expect(received[key]).toBeUndefined()
      }
      expect(response.headers.get('set-cookie')).toBeNull()
    } finally { await server.close() }
  })

  it.each(['identity', 'gzip'])('rejects oversized %s pages without returning upstream data or cookies', async (encoding) => {
    const payload = `<body>${'private-body'.repeat(2048)}</body>`
    const server = await fixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': encoding, 'set-cookie': 'private-secret=hidden' })
      res.end(encoding === 'gzip' ? gzipSync(payload) : payload)
    }, 1024)
    try {
      const response = await fetch(server.url)
      expect(response.status).toBe(502)
      const body = await response.text()
      expect(body).toContain('size limit')
      expect(body).not.toContain('private-body')
      expect(body).not.toContain('backend-only')
      expect(response.headers.get('set-cookie')).toBeNull()
    } finally { await server.close() }
  })

  it('rejects an unknown content encoding visibly and strips its cookie', async () => {
    const server = await fixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'unsupported', 'set-cookie': 'secret=hidden' })
      res.end(HTML)
    })
    try {
      const response = await fetch(server.url)
      expect(response.status).toBe(502)
      expect(await response.text()).toContain('unsupported content encoding')
      expect(response.headers.get('set-cookie')).toBeNull()
    } finally { await server.close() }
  })

  it('finishes a visible size-limit error before closing an unfinished upstream stream', async () => {
    const upstreamClosed = deferred()
    const server = await fixture((req, res) => {
      req.socket.once('close', () => { upstreamClosed.resolve() })
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'secret=hidden' })
      res.write(`<body>${'private-body'.repeat(2048)}`)
    }, 1024)
    try {
      const response = await fetch(server.url)
      expect(response.status).toBe(502)
      expect(await response.text()).toContain('size limit')
      expect(response.headers.get('set-cookie')).toBeNull()
      await upstreamClosed.promise
    } finally { await server.close() }
  })

  it('applies the bound after adding the logout control', async () => {
    const server = await fixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(HTML)
    }, 100)
    try {
      const response = await fetch(server.url)
      expect(response.status).toBe(502)
      expect(await response.text()).toContain('size limit')
    } finally { await server.close() }
  })

  it('reports malformed compressed HTML without leaking its upstream cookie', async () => {
    const server = await fixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', 'set-cookie': 'secret=hidden' })
      res.end('invalid gzip payload')
    })
    try {
      const response = await fetch(server.url)
      expect(response.status).toBe(502)
      expect(await response.text()).toContain('could not be read')
      expect(response.headers.get('set-cookie')).toBeNull()
    } finally { await server.close() }
  })

  it('strips cookies from an upstream error at the index path', async () => {
    const server = await fixture((_req, res) => { res.writeHead(503, { 'set-cookie': 'secret=hidden' }); res.end('unavailable') })
    try {
      const response = await fetch(server.url)
      expect(response.status).toBe(503)
      expect(await response.text()).toBe('unavailable')
      expect(response.headers.get('set-cookie')).toBeNull()
    } finally { await server.close() }
  })

  it('streams non-index bytes before the backend finishes and does not apply the HTML buffer limit', async () => {
    const first = deferred()
    const finish = deferred()
    const server = await fixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'set-cookie': 'secret=hidden' })
      res.write('first-chunk')
      first.resolve()
      void finish.promise.then(() => res.end('second-chunk'))
    }, 1)
    try {
      const response = await fetch(`${server.url}/stream`)
      await first.promise
      const reader = response.body?.getReader()
      if (reader === undefined) throw new Error('missing response stream')
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('first-chunk')
      expect(response.headers.get('set-cookie')).toBeNull()
      finish.resolve()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('second-chunk')
      await reader.cancel()
    } finally { finish.resolve(); await server.close() }
  })

  it('aborts active upstream HTTP work and awaits its own sockets during disposal', async () => {
    const started = deferred()
    const upstreamClosed = deferred()
    const server = await fixture((req, res) => {
      req.socket.once('close', () => { upstreamClosed.resolve() })
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.write('active')
      started.resolve()
    })
    try {
      const response = await fetch(`${server.url}/stream`)
      const reader = response.body?.getReader()
      if (reader === undefined) throw new Error('missing response stream')
      await reader.read()
      await started.promise
      await server.proxy.dispose()
      await upstreamClosed.promise
      await reader.read().catch(() => undefined)
    } finally { await server.close() }
  })

  it('strips upgrade cookies and closes both WebSocket transports on disposal', async () => {
    const closed = deferred()
    const server = await fixture((_req, res) => { res.end() })
    server.upstream.on('upgrade', (_req, socket) => {
      socket.once('close', () => { closed.resolve() })
      socket.once('end', () => { socket.end() })
      socket.resume()
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSet-Cookie: upstream-secret=hidden\r\n\r\n')
    })
    let browser: Socket | undefined
    try {
      const upgrade = await new Promise<{ response: IncomingMessage; socket: Socket }>((resolve, reject) => {
        const request = httpRequest(`${server.url}/socket`, { headers: {
          connection: 'Upgrade', upgrade: 'websocket', origin: server.binding.origin, cookie: 'sso=secret',
        } })
        request.once('error', reject)
        request.once('upgrade', (response, socket) => { resolve({ response, socket }) })
        request.end()
      })
      browser = upgrade.socket
      browser.resume()
      expect(upgrade.response.headers['set-cookie']).toBeUndefined()
      const browserClosed = new Promise<void>((resolve) => { browser?.once('close', () => { resolve() }) })
      await server.proxy.dispose()
      await Promise.all([closed.promise, browserClosed])
      expect(browser.destroyed).toBe(true)
    } finally { browser?.destroy(); await server.close() }
  })
})
