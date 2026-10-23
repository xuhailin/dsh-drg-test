/** Test-only Anthropic Messages endpoint for the real DSH runtime and hosted model proxy. */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'` }

function sharedReferenceCommand(packId, mutation) {
  const code = `
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
const root = '/opt/dsh/resources'
const packId = ${JSON.stringify(packId)}
const directory = join(root, packId)
const manifestBytes = readFileSync(join(directory, 'manifest.json'))
const manifest = JSON.parse(manifestBytes)
const catalog = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'))
const entry = catalog.packs.find(pack => pack.packId === packId)
assert.ok(entry)
assert.equal(entry.availability, 'available')
assert.equal(entry.manifestSha256, createHash('sha256').update(manifestBytes).digest('hex'))
assert.equal(manifest.packId, packId)
assert.equal(manifest.profile, 'source-only')
assert.equal(manifest.readiness.groupingReady, false)
assert.equal(manifest.source.path, 'sources/national.pdf')
assert.equal(manifest.database.path, 'reference.sqlite')
const source = join(directory, 'sources/national.pdf')
const sourceSha256 = createHash('sha256').update(readFileSync(source)).digest('hex')
assert.equal(sourceSha256, manifest.source.sha256)
assert.equal(existsSync(join(root, 'staging')), false)
assert.equal(existsSync('/opt/dsh/staging'), false)
const databaseFile = join(directory, 'reference.sqlite')
assert.equal(createHash('sha256').update(readFileSync(databaseFile)).digest('hex'), manifest.database.sha256)
const database = new DatabaseSync(databaseFile, { readOnly: true })
try {
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1)
  assert.equal(database.prepare('PRAGMA quick_check').get().quick_check, 'ok')
  const metadata = Object.fromEntries(database.prepare('SELECT key, value FROM archive_metadata').all().map(row => [row.key, row.value]))
  assert.equal(metadata.pack_id, packId)
  assert.equal(metadata.source_sha256, sourceSha256)
  assert.equal(metadata.profile, 'source-only')
  assert.equal(metadata.grouping_ready, 'false')
  const output = { packId, sourceSha256, profile: manifest.profile, groupingReady: manifest.readiness.groupingReady }
  ${mutation ? `
  const denied = []
  const deniedErrors = {}
  const mount = readFileSync('/proc/self/mountinfo', 'utf8').split('\\n').map(line => line.split(' ')).find(fields => fields[4] === root)
  assert.ok(mount?.[5].split(',').includes('ro'), 'The shared-resource mount must be read-only')
  for (const [name, attempt] of [
    ['source-write', () => { const fd = openSync(source, 'r+'); closeSync(fd) }],
    ['directory-create', () => mkdirSync(join(root, '.resource-smoke-directory'))],
    ['file-create', () => writeFileSync(join(directory, 'sources/.resource-smoke-write'), 'forbidden')],
    ['catalog-replace', () => renameSync(join(root, 'catalog.json'), join(root, '.resource-smoke-catalog'))],
    ['source-delete', () => unlinkSync(source)],
  ]) {
    let failure
    try { attempt() } catch (error) { failure = error }
    assert.ok(['EROFS', 'EACCES'].includes(failure?.code), name + ' must fail with a filesystem write denial: ' + failure?.code)
    denied.push(name)
    deniedErrors[name] = failure.code
  }
  assert.throws(() => database.exec('CREATE TABLE forbidden_smoke_write (value TEXT)'), /readonly|read.only/i)
  output.denied = denied
  output.deniedErrors = deniedErrors
  output.readOnlyMount = true
  output.sqliteReadOnly = true
  ` : ''}
  console.log(JSON.stringify(output))
} finally { database.close() }
`
  return `node --input-type=module -e ${shellQuote(code)}`
}

async function main() {
  const requests = []
  const upstreamKey = 'fake-deepseek-upstream-key'

  function json(response, status, body) {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(body))
  }

  async function body(request) {
    const chunks = []
    let bytes = 0
    for await (const chunk of request) {
      bytes += chunk.length
      if (bytes > 4_194_304) throw new Error('Model request exceeds the fixture request limit')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  function blocks(message) {
    if (typeof message?.content === 'string') return [{ type: 'text', text: message.content }]
    return Array.isArray(message?.content) ? message.content : []
  }

  function text(message) {
    return blocks(message).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
  }

  function stream(response, model, content, stopReason) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    const event = value => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
    event({ type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 16, output_tokens: 0 } } })
    if (content.type === 'tool_use') {
      event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: content.id, name: content.name, input: {} } })
      event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } })
    } else {
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content.text } })
    }
    event({ type: 'content_block_stop', index: 0 })
    event({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 16 } })
    event({ type: 'message_stop' })
    response.end()
  }

  async function handle(request, response) {
    const url = new URL(request.url, 'http://mock-model:8091')
    if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { ok: true })
    if (request.method === 'GET' && url.pathname === '/test/requests') return json(response, 200, requests)
    if (request.method !== 'POST' || url.pathname !== '/anthropic/v1/messages') return json(response, 404, { error: { type: 'not_found', message: 'Unknown fixture endpoint' } })
    if (request.headers['x-api-key'] !== upstreamKey) return json(response, 401, { error: { type: 'authentication_error', message: 'The hosted model proxy did not supply the expected test key' } })
    const input = await body(request)
    if (typeof input.model !== 'string' || !Array.isArray(input.messages) || input.stream !== true) {
      return json(response, 400, { error: { type: 'invalid_request_error', message: 'Expected a streaming Messages request' } })
    }
    const lastUser = input.messages.findLast(message => message.role === 'user' && text(message))
    const userText = text(lastUser)
    const lastBlocks = blocks(input.messages.at(-1))
    const results = lastBlocks.filter(block => block.type === 'tool_result')
    const toolNames = Array.isArray(input.tools) ? input.tools.map(tool => tool.name) : []
    requests.push({ path: url.pathname, model: input.model, apiKeyMatched: true, authorizationPresent: request.headers.authorization !== undefined, userText: userText.slice(0, 2_000), toolNames, toolResults: results.length })
    if (requests.length > 100) requests.shift()
    if (userText.includes('Generate the session title from this JSON array of human messages')) {
      return stream(response, input.model, { type: 'text', text: 'Private workspace' }, 'end_turn')
    }
    const resource = /\b(READ_SHARED_REFERENCE|DENY_SHARED_MUTATION|WRITE_SHARED_FILE)\s+([a-z0-9][a-z0-9._-]{0,127})\b/u.exec(userText)
    if (resource && results.length === 0) {
      const name = resource[1] === 'WRITE_SHARED_FILE' ? 'write' : 'bash'
      if (!toolNames.includes(name)) return json(response, 400, { error: { type: 'invalid_request_error', message: `The shared-resource marker requires the real ${name} tool` } })
      return stream(response, input.model, {
        type: 'tool_use', id: `tool_${randomUUID()}`, name,
        input: name === 'write'
          ? { file_path: `/opt/dsh/resources/${resource[2]}/sources/tool-write-denied.txt`, content: 'Shared reference data must remain read-only.\n' }
          : { description: resource[1] === 'DENY_SHARED_MUTATION' ? 'Verify shared-reference mutations are rejected' : 'Read the published shared-reference identity', command: sharedReferenceCommand(resource[2], resource[1] === 'DENY_SHARED_MUTATION') },
      }, 'tool_use')
    }
    const marker = /\b(WRITE_MARKER|APPROVE_MARKER)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,80})\b/u.exec(userText)
    if (marker && results.length === 0) {
      if (!toolNames.includes('bash')) return json(response, 400, { error: { type: 'invalid_request_error', message: 'WRITE_MARKER requires the real bash tool' } })
      const filename = marker[2]
      return stream(response, input.model, {
        type: 'tool_use',
        id: `tool_${randomUUID()}`,
        name: 'bash',
        input: {
          description: 'Write and read the private workspace marker',
          command: `printf '%s\\n' 'hosted-workspaces-marker:${filename}' > './${filename}' && cat './${filename}'`,
          ...(marker[1] === 'APPROVE_MARKER' ? {
            sandbox_permissions: 'danger-full-access',
            justification: 'Verify explicit approval for a synthetic private workspace marker.',
          } : {}),
        },
      }, 'tool_use')
    }
    const resultText = results.map(result => `${result.is_error ? 'Tool failed: ' : 'Tool result: '}${text(result)}`).join('\n')
    return stream(response, input.model, { type: 'text', text: `Mock DeepSeek: ${userText}${resultText ? `\n${resultText}` : ''}` }, 'end_turn')
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      if (response.headersSent) response.destroy(error)
      else json(response, 400, { error: { type: 'invalid_request_error', message: error.message } })
    })
  })
  server.requestTimeout = 5_000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(process.env.MOCK_MODEL_PORT ?? 8091), '0.0.0.0', resolve)
  })
  console.log(`mock-model listening on ${server.address().port}`)
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections()
    await closed
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void stop().catch(error => { console.error(error.message); process.exitCode = 1 }) })
}

await main()
