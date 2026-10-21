/** Test-only Anthropic Messages endpoint for the real DSH runtime and hosted model proxy. */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

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
