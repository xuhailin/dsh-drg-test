/** Local synthetic Docker acceptance driver; run after compose.test.yml is healthy. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'

const portal = 'http://chat.localhost:8080'
const prefix = process.env.HOSTED_PREFIX ?? 'dsh-workspace'
const composeArgs = ['compose', '-f', 'deploy/hosted-workspaces/compose.yml', '-f', 'deploy/hosted-workspaces/compose.test.yml']
function passed(message) { console.log(message) }
const sockets = new Set()

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function http(url, { cookie, method = 'GET', body, origin, headers = {} } = {}) {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: '127.0.0.1', port: target.port, path: `${target.pathname}${target.search}`, method,
      headers: { host: target.host, ...headers, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
      agent: false, timeout: 180_000,
    }, response => {
      const chunks = []
      response.on('data', chunk => { chunks.push(chunk) })
      response.once('error', reject)
      response.once('end', () => { resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }) })
    })
    outgoing.once('timeout', () => { outgoing.destroy(new Error('Docker smoke HTTP request timed out')) })
    outgoing.once('error', reject)
    outgoing.end(body)
  })
}

function credential(response, name) {
  const found = response.headers['set-cookie']?.find(value => value.startsWith(`${name}=`))
  assert.ok(found, `Missing ${name} cookie`)
  return found.split(';', 1)[0]
}

async function login(user) {
  const id = createHash('sha256').update(JSON.stringify(['http://localhost:8090', user])).digest('hex')
  const start = await http(`${portal}/auth/login`)
  assert.equal(start.status, 303)
  const flow = credential(start, 'dsh-sso-dev-flow')
  const authorization = new URL(start.headers.location)
  const form = new URLSearchParams(authorization.searchParams)
  form.set('user', user)
  const grant = await http(`${authorization.origin}/authorize`, {
    method: 'POST', body: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
  assert.equal(grant.status, 303)
  const responseType = authorization.searchParams.get('response_type')
  let callback
  let handoffTarget
  if (responseType === 'id_token') {
    assert.equal(authorization.searchParams.get('response_mode'), 'fragment')
    const target = new URL(grant.headers.location)
    assert.equal(target.origin, portal)
    assert.equal(target.pathname, '/auth/callback')
    assert.equal(target.search, '')
    const fragment = new URLSearchParams(target.hash.slice(1))
    assert.ok(fragment.get('id_token'), 'Implicit response includes an ID token')
    assert.ok(!fragment.has('access_token'), 'Implicit response must not issue an access token')
    assert.ok(fragment.get('state') === authorization.searchParams.get('state'), 'Implicit response returns the requested state')
    target.hash = ''
    const bridge = await http(target, { cookie: flow })
    assert.equal(bridge.status, 200)
    assert.equal(bridge.headers['referrer-policy'], 'same-origin')
    assert.match(bridge.text, /history\.replaceState/u)
    assert.match(bridge.text, /location\.hash/u)
    const script = /<script>([\s\S]*?)<\/script>/u.exec(bridge.text)?.[1]
    assert.ok(script, 'The implicit callback bridge includes its static script')
    const scriptHash = createHash('sha256').update(script).digest('base64')
    assert.ok(bridge.headers['content-security-policy']?.includes(`script-src 'sha256-${scriptHash}'`), 'The callback CSP permits the exact static bridge script')
    assert.match(bridge.headers['content-security-policy'], /form-action 'self'/u)
    assert.ok(script.indexOf('history.replaceState') < script.indexOf('HTMLFormElement.prototype.submit.call'), 'The callback bridge clears the URL fragment before form submission')
    assert.ok(!bridge.text.includes(fragment.get('id_token')), 'The callback bridge must not embed the ID token')
    callback = await http(target, {
      method: 'POST', cookie: flow, origin: portal, body: fragment.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    assert.equal(callback.status, 200, `Implicit OIDC callback failed: ${callback.status}`)
    assert.ok(callback.headers.location === undefined, 'The completed callback must end the form redirect chain')
    assert.equal(callback.headers['referrer-policy'], 'no-referrer')
    assert.match(callback.headers['content-security-policy'], /form-action 'none'/u)
    assert.ok(!callback.text.includes(fragment.get('id_token')), 'The completed callback page must not embed the ID token')
    const refresh = /<meta http-equiv="refresh" content="0;url=([^"]+)">/u.exec(callback.text)?.[1]
    assert.ok(refresh, 'The completed callback page includes its personal handoff target')
    handoffTarget = new URL(refresh)
    const expected = new URL(portal)
    expected.hostname = `u-${id.slice(0, 40)}.${expected.hostname}`
    assert.equal(handoffTarget.origin, expected.origin)
    assert.equal(handoffTarget.pathname, '/auth/handoff')
    assert.equal(handoffTarget.hash, '')
    assert.deepEqual([...handoffTarget.searchParams.keys()], ['ticket'])
    assert.ok(handoffTarget.searchParams.get('ticket'), 'The handoff ticket must be nonempty')
  } else {
    assert.equal(responseType, 'code')
    callback = await http(grant.headers.location, { cookie: flow })
    assert.equal(callback.status, 303, `OIDC callback failed: ${callback.status}`)
    handoffTarget = new URL(callback.headers.location)
  }
  const handoff = await http(handoffTarget, { origin: authorization.origin, headers: { "sec-fetch-site": "cross-site" } })
  assert.equal(handoff.status, 200)
  assert.match(handoff.text, /<meta http-equiv="refresh" content="0;url=\/">/u)
  const origin = handoffTarget.origin
  const cookie = credential(handoff, 'dsh-sso-dev')
  return { origin, cookie, id, container: `${prefix}-${id}`, flow: responseType === 'code' ? 'code + PKCE' : 'implicit ID token' }
}

async function rpc(user, method, args) {
  const response = await http(`${user.origin}/api/${method}`, {
    method: 'POST', cookie: user.cookie, origin: user.origin, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
  })
  assert.equal(response.status, 200, `${method}: HTTP ${response.status}`)
  const result = JSON.parse(response.text).result
  assert.equal(result.ok, true, `${method}: ${JSON.stringify(result.error)}`)
  return result.value
}

async function connect(user) {
  const target = new URL(user.origin)
  const socket = new WebSocket(`ws://127.0.0.1:${target.port}/api/remote.mux`, {
    headers: { host: target.host, cookie: user.cookie, origin: user.origin },
  })
  sockets.add(socket)
  socket.once('close', () => { sockets.delete(socket) })
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  return socket
}

async function page(user, sessionId) {
  const socket = await connect(user)
  try {
    const streamId = randomUUID()
    const cursor = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('No session opening snapshot')) }, 10_000)
      socket.on('message', data => {
        const frame = JSON.parse(data.toString())
        if (frame.streamId !== streamId) return
        if (frame.type === 'item' && frame.value.type === 'snapshot') { clearTimeout(timer); resolve(frame.value.cursor) }
        if (frame.type === 'error') { clearTimeout(timer); reject(new Error(JSON.stringify(frame.error))) }
      })
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }))
    })
    return await rpc(user, 'session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: cursor, maxMessages: 30 } })
  } finally { socket.terminate() }
}

async function waitFor(check, message, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(200)
  }
  throw new Error(message)
}

function assistantText(history) {
  return history.records.filter(record => record.type === 'event' && record.event.type === 'assistant/message')
    .flatMap(record => record.event.data.message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
}

async function main() {
  assert.equal((await http(`${portal}/healthz`)).status, 200)
  const alice = await login('alice')
  const bob = await login('bob')
  assert.notEqual(alice.origin, bob.origin)
  for (const user of [alice, bob]) {
    const index = await http(user.origin, { cookie: user.cookie })
    assert.equal(index.status, 200, 'Personal runtime index')
    assert.match(index.text, /\/auth\/logout/u)
  }
  assert.equal(alice.flow, bob.flow)
  passed(`OIDC ${alice.flow} login and separate personal origins: PASS`)
  assert.equal((await http(`${bob.origin}/api/session/list`, { cookie: alice.cookie, method: 'POST' })).status, 403)
  assert.equal((await http(`${alice.origin}/api/session/list`, { method: 'POST' })).status, 401)
  assert.equal((await http(`${alice.origin}/api/session/list`, { cookie: alice.cookie, method: 'POST', origin: bob.origin })).status, 403)
  passed('Anonymous, cross-user cookie and cross-origin API requests rejected: PASS')

  const defaultSession = await rpc(alice, 'session/create', { request: { cwd: '/home/node/workspace' } })
  await rpc(alice, 'session/prompt', { request: { requestId: randomUUID(), sessionId: defaultSession.sessionId, mode: 'queue', content: [{ type: 'text', text: 'WRITE_MARKER default-sandbox.txt' }] } })
  await waitFor(async () => /Tool (?:result|failed):/u.test(assistantText(await page(alice, defaultSession.sessionId))), 'Default permission Bash round did not settle')
  assert.match(assistantText(await page(alice, defaultSession.sessionId)), /Tool result:/u, 'Default sandbox must execute without weakening the container')
  assert.match(docker('exec', alice.container, 'cat', '/home/node/workspace/default-sandbox.txt'), /hosted-workspaces-marker:/u)
  passed('Default workspace permission executes the real Bash tool with container isolation retained: PASS')

  const created = await Promise.all([[alice, 'alice-private.txt'], [bob, 'bob-private.txt']].map(async ([user, marker]) => {
    const session = await rpc(user, 'session/create', { request: { cwd: '/home/node/workspace' } })
    const permission = await rpc(user, 'commands/execute', { agentId: session.sessionId, line: '/permission danger-full-access', submittedAttachments: [] })
    assert.equal(permission.result.kind, 'success')
    await rpc(user, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: `WRITE_MARKER ${marker}` }] } })
    await waitFor(async () => assistantText(await page(user, session.sessionId)).includes('Tool result:'), 'Real Bash round did not complete')
    assert.match(docker('exec', user.container, 'cat', `/home/node/workspace/${marker}`), /hosted-workspaces-marker:/u)
    return session.sessionId
  }))
  passed('Concurrent real Web profiles, streamed model requests and Bash file write/read for both accounts: PASS')
  const aliceList = await rpc(alice, 'session/list', { _request: {} })
  const bobList = await rpc(bob, 'session/list', { _request: {} })
  assert.ok(aliceList.items.some(item => item.sessionId === created[0]))
  assert.ok(!aliceList.items.some(item => item.sessionId === created[1]))
  assert.ok(bobList.items.some(item => item.sessionId === created[1]))
  assert.ok(!bobList.items.some(item => item.sessionId === created[0]))
  passed('Personal session lists do not expose the other account: PASS')
  assert.match(assistantText(await page(bob, created[1])), /bob-private\.txt/u)
  await assert.rejects(page(bob, created[0]), /not.found|not_found|missing|unavailable/iu)
  await assert.rejects(page(alice, created[1]), /not.found|not_found|missing|unavailable/iu)
  passed('Replaying another account\'s session ID cannot read its transcript: PASS')

  const inspections = [alice, bob].map(user => JSON.parse(docker('inspect', user.container))[0])
  const [a, b] = inspections
  for (const item of inspections) {
    assert.equal(item.Config.User, '1000:1000')
    assert.equal(item.HostConfig.ReadonlyRootfs, true)
    assert.deepEqual(item.HostConfig.CapDrop, ['ALL'])
    assert.deepEqual(item.HostConfig.SecurityOpt, ['no-new-privileges:true'])
    assert.equal(item.Mounts.length, 1)
    assert.equal(item.Mounts[0].Destination, '/home/node')
    assert.ok(!item.Config.Env.some(value => value.includes('fake-deepseek-upstream-key')))
    assert.ok(!Object.keys(item.NetworkSettings.Ports ?? {}).some(port => item.NetworkSettings.Ports[port]?.length))
  }
  assert.notEqual(a.Mounts[0].Name, b.Mounts[0].Name)
  assert.notEqual(a.HostConfig.NetworkMode, b.HostConfig.NetworkMode)
  docker('exec', alice.container, 'sh', '-c', 'test ! -e /var/run/docker.sock && test ! -e /run/secrets/deepseek_api_key && test ! -e /home/node/workspace/bob-private.txt')
  const bobIp = Object.values(b.NetworkSettings.Networks)[0].IPAddress
  docker('exec', alice.container, 'node', '--input-type=module', '-e', `try { await fetch('http://${bobIp}:3080/', {signal:AbortSignal.timeout(1500)});process.exit(1) } catch { process.exit(0) }`)
  passed('Distinct volumes/networks; no published runtime ports, control socket or real upstream key; peer network unreachable: PASS')

  docker('restart', alice.container)
  assert.equal((await http(alice.origin, { cookie: alice.cookie })).status, 200)
  assert.match(docker('exec', alice.container, 'cat', '/home/node/workspace/alice-private.txt'), /hosted-workspaces-marker:/u)
  passed('Personal runtime restart preserves access and private files: PASS')
  docker(...composeArgs, 'restart', 'gateway')
  await waitFor(async () => {
    try { return (await http(`${portal}/healthz`)).status === 200 } catch { return false }
  }, 'Gateway did not recover')
  passed('Published gateway entry recovers after restart: PASS')
  const restored = await rpc(alice, 'session/list', { _request: {} })
  assert.ok(restored.items.some(item => item.sessionId === created[0]))
  assert.ok(!restored.items.some(item => item.sessionId === created[1]))
  const recoveredMarker = `after-restart-${randomUUID()}`
  await rpc(alice, 'session/prompt', { request: { requestId: randomUUID(), sessionId: created[0], mode: 'queue', content: [{ type: 'text', text: recoveredMarker }] } })
  await waitFor(async () => assistantText(await page(alice, created[0])).includes(`Mock DeepSeek: ${recoveredMarker}`), 'Model listener did not recover after restart')
  const restoredTranscript = assistantText(await page(alice, created[0]))
  assert.match(restoredTranscript, /alice-private\.txt/u)
  assert.match(restoredTranscript, /Tool result:/u)
  assert.doesNotMatch(restoredTranscript, /bob-private\.txt/u)
  passed('Runtime and gateway restart preserve login, files/history and restore new model requests: PASS')

  const freshAlice = await login('alice')
  assert.equal(freshAlice.id, alice.id)
  assert.equal(freshAlice.origin, alice.origin)
  assert.notEqual(freshAlice.cookie, alice.cookie)
  assert.equal((await http(freshAlice.origin, { cookie: freshAlice.cookie })).status, 200)
  assert.equal(assistantText(await page(freshAlice, created[0])), restoredTranscript)
  const freshList = await rpc(freshAlice, 'session/list', { _request: {} })
  assert.ok(!freshList.items.some(item => item.sessionId === created[1]))
  passed('Fresh independent login recovers the same identity, origin and complete private transcript: PASS')

  const aliceSocket = await connect(alice)
  const bobSocket = await connect(bob)
  const closed = new Promise(resolve => { aliceSocket.once('close', resolve) })
  const logout = await http(`${alice.origin}/auth/logout`, { method: 'POST', cookie: alice.cookie, origin: alice.origin })
  assert.equal(logout.status, 303)
  await Promise.race([closed, delay(5000).then(() => { throw new Error('Logout did not revoke WebSocket') })])
  assert.equal((await http(`${alice.origin}/api/session/list`, { method: 'POST', cookie: alice.cookie })).status, 401)
  assert.equal(bobSocket.readyState, WebSocket.OPEN)
  await rpc(bob, 'session/list', { _request: {} })
  passed('Logout revokes Alice HTTP/WebSocket access while Bob stays connected: PASS')
}

try { await main() } finally { for (const socket of sockets) socket.terminate() }
