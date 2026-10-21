/** Test-only OIDC provider for the real Docker deployment; no production login route loads this file. */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { createServer } from 'node:http'

async function main() {
  const issuer = process.env.MOCK_OIDC_ISSUER ?? 'http://localhost:8090'
  const internalOrigin = process.env.MOCK_OIDC_INTERNAL_ORIGIN ?? 'http://mock-oidc:8090'
  const redirectUri = process.env.MOCK_OIDC_REDIRECT_URI ?? 'http://chat.localhost:8080/auth/callback'
  const portal = new URL(redirectUri)
  const clientId = 'dsh-workspaces'
  const clientSecret = 'fake-oidc-client-secret'
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicJwk = publicKey.export({ format: 'jwk' })
  const kid = createHash('sha256').update(publicJwk.n).digest('hex').slice(0, 16)
  const jwks = { keys: [{ ...publicJwk, kid, use: 'sig', alg: 'RS256' }] }
  const codes = new Map()
  const users = { alice: 'Alice', bob: 'Bob' }

  function json(response, status, body, headers = {}) {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
    response.end(JSON.stringify(body))
  }

  async function form(request) {
    const chunks = []
    let bytes = 0
    for await (const chunk of request) {
      bytes += chunk.length
      if (bytes > 16_384) throw new Error('Form exceeds the fixture request limit')
      chunks.push(chunk)
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
  }

  function authorization(parameters) {
    const values = {}
    const required = ['client_id', 'response_type', 'redirect_uri', 'scope', 'state', 'nonce']
    if (parameters.get('response_type') === 'code') required.push('code_challenge', 'code_challenge_method')
    else required.push('response_mode')
    for (const name of required) {
      const candidates = parameters.getAll(name)
      if (candidates.length !== 1 || !candidates[0]) throw new Error(`Missing or duplicated ${name}`)
      values[name] = candidates[0]
    }
    const code = values.response_type === 'code' && values.code_challenge_method === 'S256'
      && /^[A-Za-z0-9_-]{43}$/u.test(values.code_challenge)
      && (parameters.get('response_mode') === null || parameters.get('response_mode') === 'query')
    const implicit = values.response_type === 'id_token' && values.response_mode === 'fragment'
    if (values.client_id !== clientId || values.redirect_uri !== redirectUri
      || !values.scope.split(' ').includes('openid') || (!code && !implicit)) {
      throw new Error('Unsupported authorization request')
    }
    return values
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
  }

  function token(claims) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url')
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const input = `${header}.${payload}`
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`
  }

  async function handle(request, response) {
    const url = new URL(request.url, issuer)
    if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { ok: true })
    if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      return json(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${internalOrigin}/token`,
        jwks_uri: `${internalOrigin}/jwks`,
        response_types_supported: ['code', 'id_token'],
        response_modes_supported: ['query', 'fragment'],
        grant_types_supported: ['authorization_code', 'implicit'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'profile'],
        authorization_response_iss_parameter_supported: true,
      })
    }
    if (request.method === 'GET' && url.pathname === '/jwks') return json(response, 200, jwks)
    if (url.pathname === '/authorize' && (request.method === 'GET' || request.method === 'POST')) {
      const parameters = request.method === 'GET' ? url.searchParams : await form(request)
      const values = authorization(parameters)
      if (request.method === 'GET') {
        const hidden = Object.entries(values).map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`).join('')
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': `default-src 'none'; form-action 'self' ${portal.origin} ${portal.protocol}//*.${portal.host}; frame-ancestors 'none'; base-uri 'none'`,
        })
        return response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mock company SSO</title></head><body><h1>Mock company SSO</h1><p>Choose a test account.</p><form action="/authorize" method="post">${hidden}<button name="user" value="alice" type="submit">Sign in as Alice</button><button name="user" value="bob" type="submit">Sign in as Bob</button></form></body></html>`)
      }
      const user = parameters.get('user')
      if (!Object.hasOwn(users, user)) return json(response, 400, { error: 'invalid_test_user' })
      const callback = new URL(values.redirect_uri)
      if (values.response_type === 'id_token') {
        const now = Math.floor(Date.now() / 1000)
        callback.hash = new URLSearchParams({
          id_token: token({ iss: issuer, aud: clientId, sub: user, name: users[user], preferred_username: user, nonce: values.nonce, iat: now, exp: now + 300 }),
          state: values.state, iss: issuer,
        }).toString()
        response.writeHead(303, { location: callback.href, 'cache-control': 'no-store' })
        return response.end()
      }
      for (const [code, record] of codes) if (record.expiresAt <= Date.now()) codes.delete(code)
      if (codes.size >= 256) return json(response, 503, { error: 'too_many_pending_codes' })
      const code = randomBytes(32).toString('base64url')
      codes.set(code, { ...values, user, expiresAt: Date.now() + 120_000 })
      callback.searchParams.set('code', code)
      callback.searchParams.set('state', values.state)
      callback.searchParams.set('iss', issuer)
      response.writeHead(303, { location: callback.href, 'cache-control': 'no-store' })
      return response.end()
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      let authenticated = false
      try {
        const header = request.headers.authorization
        if (typeof header === 'string' && header.startsWith('Basic ')) {
          const credentials = Buffer.from(header.slice(6), 'base64').toString('utf8')
          const separator = credentials.indexOf(':')
          authenticated = separator !== -1
            && decodeURIComponent(credentials.slice(0, separator)) === clientId
            && decodeURIComponent(credentials.slice(separator + 1)) === clientSecret
        }
      } catch (_malformedBasicEncoding) {
        // Invalid percent encoding is an invalid client credential.
      }
      if (!authenticated) {
        return json(response, 401, { error: 'invalid_client' }, { 'www-authenticate': 'Basic' })
      }
      const parameters = await form(request)
      const code = parameters.get('code')
      const record = codes.get(code)
      codes.delete(code)
      const verifier = parameters.get('code_verifier') ?? ''
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      if (!record || record.expiresAt <= Date.now() || parameters.get('grant_type') !== 'authorization_code'
        || parameters.get('redirect_uri') !== record.redirect_uri || challenge !== record.code_challenge
        || !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) {
        return json(response, 400, { error: 'invalid_grant' })
      }
      const now = Math.floor(Date.now() / 1000)
      return json(response, 200, {
        access_token: randomBytes(32).toString('base64url'),
        token_type: 'Bearer',
        expires_in: 300,
        id_token: token({ iss: issuer, aud: clientId, sub: record.user, name: users[record.user], preferred_username: record.user, nonce: record.nonce, iat: now, exp: now + 300 }),
      })
    }
    return json(response, 404, { error: 'not_found' })
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      if (response.headersSent) response.destroy(error)
      else json(response, 400, { error: 'invalid_request', error_description: error.message })
    })
  })
  server.requestTimeout = 5_000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(process.env.MOCK_OIDC_PORT ?? 8090), '0.0.0.0', resolve)
  })
  console.log(`mock-oidc listening on ${server.address().port}`)
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    codes.clear()
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections()
    await closed
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void stop().catch(error => { console.error(error.message); process.exitCode = 1 }) })
}

await main()
