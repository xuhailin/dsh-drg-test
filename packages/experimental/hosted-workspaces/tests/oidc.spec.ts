/** Exercises real OIDC discovery, authorization-code exchange, PKCE, and signed ID tokens. */
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { text as readText } from 'node:stream/consumers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OidcLogin, type OidcLoginOptions } from '../src/oidc.ts'

interface AuthorizationCode {
  nonce: string
  challenge: string
  redirectUri: string
  subject: string
}

class TestProvider {
  readonly codes = new Map<string, AuthorizationCode>()
  readonly failures: unknown[] = []
  readonly tokenRequests: URLSearchParams[] = []
  readonly key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  readonly foreignKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  readonly server = createServer((request, response) => {
    void this.handle(request, response).catch((error: unknown) => {
      this.failures.push(error)
      response.writeHead(500).end('Fixture failed')
    })
  })
  issuer = ''
  discoveryIssuer: string | undefined
  missingMetadataField: string | undefined
  claims: Record<string, unknown> = {}
  omitIdToken = false
  foreignSignature = false
  holdTokenResponse = false
  tokenStarted: Promise<void>
  private reportTokenStarted: () => void = () => {}

  constructor() {
    this.tokenStarted = new Promise((resolve) => { this.reportTokenStarted = resolve })
  }

  async start(): Promise<void> {
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('Fixture did not bind TCP')
    this.issuer = `http://127.0.0.1:${address.port}`
  }

  async authorize(authorizationUrl: string, subject = 'doctor-a'): Promise<URL> {
    const url = new URL(authorizationUrl)
    url.searchParams.set('test_subject', subject)
    const response = await fetch(url, { redirect: 'manual' })
    const location = response.headers.get('location')
    if (response.status !== 302 || location === null) throw new Error('Fixture authorization did not redirect')
    return new URL(location)
  }

  async close(): Promise<void> {
    const closed = new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    this.server.closeAllConnections()
    await closed
    expect(this.failures).toEqual([])
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.issuer)
    if (url.pathname === '/.well-known/openid-configuration') {
      const metadata: Record<string, unknown> = {
        issuer: this.discoveryIssuer ?? this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
      }
      this.json(response, Object.fromEntries(Object.entries(metadata).filter(([name]) => name !== this.missingMetadataField)))
      return
    }
    if (url.pathname === '/jwks') {
      this.json(response, { keys: [{ ...this.key.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }] })
      return
    }
    if (url.pathname === '/authorize') {
      if (url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256') {
        throw new Error('Fixture requires code flow and PKCE S256')
      }
      const redirectUri = requiredParameter(url.searchParams, 'redirect_uri')
      const callback = new URL(redirectUri)
      const code = randomUUID()
      this.codes.set(code, {
        nonce: requiredParameter(url.searchParams, 'nonce'),
        challenge: requiredParameter(url.searchParams, 'code_challenge'),
        redirectUri,
        subject: requiredParameter(url.searchParams, 'test_subject'),
      })
      callback.searchParams.set('code', code)
      callback.searchParams.set('state', requiredParameter(url.searchParams, 'state'))
      response.writeHead(302, { location: callback.href }).end()
      return
    }
    if (url.pathname === '/token') {
      const parameters = new URLSearchParams(await readText(request))
      this.tokenRequests.push(parameters)
      this.reportTokenStarted()
      if (this.holdTokenResponse) return
      const code = requiredParameter(parameters, 'code')
      const authorization = this.codes.get(code)
      this.codes.delete(code)
      const challenge = createHash('sha256').update(requiredParameter(parameters, 'code_verifier')).digest('base64url')
      const basicAuthorization = request.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(request.headers.authorization.slice(6), 'base64').toString('utf8').split(':').map(decodeURIComponent)
        : []
      const clientAuthenticated = parameters.get('client_id') === 'dsh-test'
        || (basicAuthorization[0] === 'dsh-test' && basicAuthorization[1] === 'test-secret')
      if (authorization === undefined
        || authorization.challenge !== challenge
        || authorization.redirectUri !== parameters.get('redirect_uri')
        || parameters.get('grant_type') !== 'authorization_code'
        || !clientAuthenticated) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }))
        return
      }
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url')
      const payload = Buffer.from(JSON.stringify({
        iss: this.issuer,
        aud: 'dsh-test',
        sub: authorization.subject,
        name: 'Doctor A',
        nonce: authorization.nonce,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        ...this.claims,
      })).toString('base64url')
      const signed = `${header}.${payload}`
      const signature = sign('RSA-SHA256', Buffer.from(signed), this.foreignSignature ? this.foreignKey.privateKey : this.key.privateKey).toString('base64url')
      this.json(response, {
        access_token: 'must-remain-private',
        refresh_token: 'also-private',
        token_type: 'Bearer',
        expires_in: 300,
        ...(this.omitIdToken ? {} : { id_token: `${signed}.${signature}` }),
      })
      return
    }
    response.writeHead(404).end()
  }

  private json(response: ServerResponse, value: object): void {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  }
}

function requiredParameter(parameters: URLSearchParams, key: string): string {
  const value = parameters.get(key)
  if (value === null) throw new Error(`Fixture missing ${key}`)
  return value
}

describe('OIDC login', () => {
  let provider: TestProvider
  const owners: OidcLogin[] = []
  const returnOrigin = 'http://workspace.test'
  const redirectUri = `${returnOrigin}/auth/callback`

  beforeEach(async () => {
    provider = new TestProvider()
    await provider.start()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(owners.splice(0).map(owner => owner.dispose()))
    await provider.close()
  })

  async function createLogin(overrides: Partial<OidcLoginOptions> = {}): Promise<OidcLogin> {
    const login = await OidcLogin.create({
      issuer: provider.issuer,
      clientId: 'dsh-test',
      redirectUri,
      allowInsecureHttp: true,
      flowTtlMs: 300_000,
      maxPendingFlows: 10,
      requestTimeoutMs: 5_000,
      ...overrides,
    })
    owners.push(login)
    return login
  }

  it('authenticates two subjects through signed code exchanges without returning OAuth tokens', async () => {
    const login = await createLogin({ clientSecret: 'test-secret' })
    const first = await login.begin(returnOrigin)
    const firstUrl = new URL(first.authorizationUrl)
    expect(firstUrl.searchParams.get('scope')).toBe('openid profile')
    expect(firstUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(first.flowCookie).not.toBe(firstUrl.searchParams.get('state'))
    expect(firstUrl.searchParams.has('code_verifier')).toBe(false)
    const firstResult = await login.finish(await provider.authorize(first.authorizationUrl), first.flowCookie)
    expect(firstResult).toEqual({ identity: { issuer: provider.issuer, subject: 'doctor-a', name: 'Doctor A' }, returnOrigin })
    const second = await login.begin(returnOrigin)
    expect(second.flowCookie).not.toBe(first.flowCookie)
    expect(await login.finish(await provider.authorize(second.authorizationUrl, 'doctor-b'), second.flowCookie)).toEqual({
      identity: { issuer: provider.issuer, subject: 'doctor-b', name: 'Doctor A' },
      returnOrigin,
    })
    expect(provider.tokenRequests).toHaveLength(2)
  })

  it('discovers through an internal URL while requiring the configured public issuer', async () => {
    const issuer = 'https://sso.example.test'
    provider.discoveryIssuer = issuer
    const login = await createLogin({ issuer, discoveryUrl: `${provider.issuer}/.well-known/openid-configuration` })
    expect(new URL((await login.begin(returnOrigin)).authorizationUrl).origin).toBe(provider.issuer)
    provider.discoveryIssuer = 'https://wrong.example.test'
    await expect(createLogin({ issuer, discoveryUrl: `${provider.issuer}/.well-known/openid-configuration` })).rejects.toMatchObject({ kind: 'configuration' })
  })

  it.each([
    ['missing cookie', undefined],
    ['different browser', 'another-browser'],
    ['same-length wrong cookie', 'a'.repeat(43)],
  ])('rejects %s before exchanging a code', async (_description, cookie) => {
    const login = await createLogin()
    const flow = await login.begin(returnOrigin)
    const callback = await provider.authorize(flow.authorizationUrl)
    await expect(login.finish(callback, cookie)).rejects.toMatchObject({ kind: 'invalid-flow' })
    await expect(login.finish(callback, flow.flowCookie)).rejects.toMatchObject({ kind: 'invalid-flow' })
    expect(provider.tokenRequests).toHaveLength(0)
  })

  it('rejects unknown and duplicate states without authenticating', async () => {
    const login = await createLogin()
    const flow = await login.begin(returnOrigin)
    const callback = await provider.authorize(flow.authorizationUrl)
    callback.searchParams.set('state', 'attacker-state')
    await expect(login.finish(callback, flow.flowCookie)).rejects.toMatchObject({ kind: 'invalid-flow' })
    callback.searchParams.append('state', requiredParameter(new URL(flow.authorizationUrl).searchParams, 'state'))
    await expect(login.finish(callback, flow.flowCookie)).rejects.toMatchObject({ kind: 'invalid-flow' })
    expect(provider.tokenRequests).toHaveLength(0)
  })

  it('consumes successful callbacks once, including overlapping attempts', async () => {
    const login = await createLogin()
    const flow = await login.begin(returnOrigin)
    const callback = await provider.authorize(flow.authorizationUrl)
    const results = await Promise.allSettled([login.finish(callback, flow.flowCookie), login.finish(callback, flow.flowCookie)])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    await expect(login.finish(callback, flow.flowCookie)).rejects.toMatchObject({ kind: 'invalid-flow' })
    expect(provider.tokenRequests).toHaveLength(1)
  })

  it.each([
    ['issuer', { iss: 'https://foreign.test' }],
    ['audience', { aud: 'another-client' }],
    ['nonce', { nonce: 'another-login' }],
    ['expiration', { exp: 1 }],
    ['subject', { sub: '' }],
  ])('rejects an ID token with invalid %s', async (_description, claims) => {
    provider.claims = claims
    const login = await createLogin()
    const flow = await login.begin(returnOrigin)
    await expect(login.finish(await provider.authorize(flow.authorizationUrl), flow.flowCookie)).rejects.toMatchObject({ kind: 'provider' })
  })

  it('rejects a forged token even when its claims match the authorization attempt', async () => {
    provider.foreignSignature = true
    const login = await createLogin()
    const flow = await login.begin(returnOrigin)
    await expect(login.finish(await provider.authorize(flow.authorizationUrl), flow.flowCookie)).rejects.toMatchObject({ kind: 'provider' })
  })

  it('requires an ID token', async () => {
    provider.omitIdToken = true
    const login = await createLogin()
    const flow = await login.begin(returnOrigin)
    await expect(login.finish(await provider.authorize(flow.authorizationUrl), flow.flowCookie)).rejects.toMatchObject({ kind: 'provider' })
  })

  it('uses only validated display-name claims, falling back to the stable subject', async () => {
    provider.claims = { name: '', preferred_username: 'Dr Lin' }
    const login = await createLogin()
    const flow = await login.begin(returnOrigin)
    expect((await login.finish(await provider.authorize(flow.authorizationUrl), flow.flowCookie)).identity.name).toBe('Dr Lin')
    provider.claims = { name: 42, preferred_username: '' }
    const fallback = await login.begin(returnOrigin)
    expect((await login.finish(await provider.authorize(fallback.authorizationUrl), fallback.flowCookie)).identity.name).toBe('doctor-a')
  })

  it('expires old flows and reclaims their bounded capacity', async () => {
    const login = await createLogin({ maxPendingFlows: 1, flowTtlMs: 100 })
    const originalNow = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(originalNow - 1_000)
    const expired = await login.begin(returnOrigin)
    clock.mockRestore()
    await expect(login.finish(await provider.authorize(expired.authorizationUrl), expired.flowCookie)).rejects.toMatchObject({ kind: 'invalid-flow' })
    const pending = await login.begin(returnOrigin)
    await expect(login.begin(returnOrigin)).rejects.toMatchObject({ kind: 'capacity' })
    expect((await login.finish(await provider.authorize(pending.authorizationUrl), pending.flowCookie)).identity.subject).toBe('doctor-a')
    await expect(login.begin(returnOrigin)).resolves.toHaveProperty('authorizationUrl')
  })

  it('reclaims capacity when abandoned authorization attempts expire', async () => {
    const login = await createLogin({ maxPendingFlows: 1, flowTtlMs: 100 })
    const originalNow = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(originalNow - 1_000)
    const abandoned = await login.begin(returnOrigin)
    clock.mockRestore()
    await expect(login.begin(returnOrigin)).resolves.toHaveProperty('authorizationUrl')
    await expect(login.finish(await provider.authorize(abandoned.authorizationUrl), abandoned.flowCookie)).rejects.toMatchObject({ kind: 'invalid-flow' })
  })

  it('rejects a callback on an unregistered path before exchanging its code', async () => {
    const login = await createLogin()
    const flow = await login.begin(returnOrigin)
    const callback = await provider.authorize(flow.authorizationUrl)
    callback.pathname = '/another-callback'
    await expect(login.finish(callback, flow.flowCookie)).rejects.toMatchObject({ kind: 'invalid-flow' })
    expect(provider.tokenRequests).toHaveLength(0)
  })

  it('refuses insecure provider configuration unless development HTTP is explicit', async () => {
    await expect(createLogin({ allowInsecureHttp: false })).rejects.toMatchObject({ kind: 'configuration' })
    await expect(createLogin({ issuer: 'not a URL' })).rejects.toMatchObject({ kind: 'configuration' })
    await expect(createLogin({ redirectUri: `${redirectUri}?unexpected=1` })).rejects.toMatchObject({ kind: 'configuration' })
    const login = await createLogin()
    await expect(login.begin(`${returnOrigin}/untrusted-path`)).rejects.toMatchObject({ kind: 'configuration' })
  })

  it('reports provider discovery failure without publishing a login owner', async () => {
    await expect(createLogin({
      issuer: provider.issuer.replace('http:', 'https:'),
      redirectUri: redirectUri.replace('http:', 'https:'),
      allowInsecureHttp: false,
    })).rejects.toMatchObject({ kind: 'discovery' })
  })

  it.each(['authorization_endpoint', 'token_endpoint', 'jwks_uri'])('requires discovered %s before accepting logins', async (name) => {
    provider.missingMetadataField = name
    await expect(createLogin()).rejects.toMatchObject({ kind: 'configuration' })
  })

  it('cancels a login whose authorization URL is still being prepared', async () => {
    const login = await createLogin()
    const beginning = expect(login.begin(returnOrigin)).rejects.toMatchObject({ kind: 'disposed' })
    await login.dispose()
    await beginning
  })

  it('aborts an in-flight exchange and rejects all operations after disposal', async () => {
    provider.holdTokenResponse = true
    const login = await createLogin()
    const flow = await login.begin(returnOrigin)
    const callback = await provider.authorize(flow.authorizationUrl)
    const finished = expect(login.finish(callback, flow.flowCookie)).rejects.toMatchObject({ kind: 'disposed' })
    await provider.tokenStarted
    await login.dispose()
    await finished
    await expect(login.begin(returnOrigin)).rejects.toMatchObject({ kind: 'disposed' })
    await expect(login.finish(callback, flow.flowCookie)).rejects.toMatchObject({ kind: 'disposed' })
    await login.dispose()
  })

  it('bounds stalled provider requests by the configured request timeout', async () => {
    provider.holdTokenResponse = true
    const login = await createLogin({ requestTimeoutMs: 1_000 })
    const flow = await login.begin(returnOrigin)
    const callback = await provider.authorize(flow.authorizationUrl)
    const finished = expect(login.finish(callback, flow.flowCookie)).rejects.toMatchObject({ kind: 'provider' })
    await provider.tokenStarted
    await finished
  })
})
