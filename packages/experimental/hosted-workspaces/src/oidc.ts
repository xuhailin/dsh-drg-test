/** OIDC authorization-code login with browser binding and instance-owned, one-use flows. */
import { timingSafeEqual } from 'node:crypto'
import * as client from 'openid-client'

/** Deployment settings for one OIDC relying party. */
export interface OidcLoginOptions {
  issuer: string
  /** Omit to discover through issuer; an internal discovery URL must report the same issuer. */
  discoveryUrl?: string
  clientId: string
  /** Omit only for a registered public client; confidential clients use client_secret_basic. */
  clientSecret?: string
  redirectUri: string
  /** Permit HTTP only in explicitly configured development environments. */
  allowInsecureHttp: boolean
  flowTtlMs: number
  maxPendingFlows: number
  requestTimeoutMs: number
}

/** Validated identity fields; no access, refresh, or ID token escapes the login operation. */
export interface OidcIdentity {
  issuer: string
  subject: string
  name: string
}

/** Login failure categories that callers can map to safe, localized HTTP responses. */
export type OidcLoginErrorKind = 'configuration' | 'discovery' | 'capacity' | 'invalid-flow' | 'provider' | 'disposed'

/** A login failure leaves the caller unauthenticated and requires a fresh login attempt. */
export class OidcLoginError extends Error {
  /**
   * @param kind Failure category for HTTP response selection.
   * @param message Diagnostic for trusted operators; callers own user-facing localization.
   * @param options Preserve the provider or transport failure without returning it to browsers.
   */
  constructor(readonly kind: OidcLoginErrorKind, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OidcLoginError'
  }
}

interface PendingFlow {
  browserBinding: string
  codeVerifier: string
  nonce: string
  returnOrigin: string
  expiresAt: number
}

/** Owns OIDC discovery, pending browser logins, and cancellation of its provider requests. */
export class OidcLogin {
  private readonly flows = new Map<string, PendingFlow>()
  private readonly operations = new Set<Promise<unknown>>()

  private constructor(
    private readonly configuration: client.Configuration,
    private readonly lifetime: AbortController,
    private readonly issuer: string,
    private readonly redirectUri: string,
    private readonly allowInsecureHttp: boolean,
    private readonly flowTtlMs: number,
    private readonly maxPendingFlows: number,
  ) {}

  /**
   * Discovers provider metadata and requires signature-verified ID tokens.
   * @param options Explicit provider, browser callback, and resource limits.
   * @returns Ready login owner; rejects with OidcLoginError without publishing an owner on failure.
   */
  static async create(options: OidcLoginOptions): Promise<OidcLogin> {
    const issuer = parseEndpoint(options.issuer, options.allowInsecureHttp, 'issuer')
    const redirectUri = parseEndpoint(options.redirectUri, options.allowInsecureHttp, 'redirectUri')
    if (issuer.search || issuer.hash || redirectUri.search || redirectUri.hash) {
      throw new OidcLoginError('configuration', 'OIDC issuer and redirectUri must not contain query strings or fragments.')
    }
    const discoveryUrl = options.discoveryUrl === undefined
      ? issuer
      : parseEndpoint(options.discoveryUrl, options.allowInsecureHttp, 'discoveryUrl')
    const lifetime = new AbortController()
    const fetchProvider: client.CustomFetch = (url, init) => fetch(url, {
      ...init,
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.requestTimeoutMs)]),
      // openid-client permits ArrayBufferLike views and explicit undefined fields accepted by Node fetch.
    } as RequestInit)
    let configuration: client.Configuration
    try {
      configuration = await client.discovery(
        discoveryUrl,
        options.clientId,
        options.clientSecret,
        options.clientSecret === undefined ? client.None() : client.ClientSecretBasic(options.clientSecret),
        {
          timeout: options.requestTimeoutMs / 1000,
          [client.customFetch]: fetchProvider,
          execute: options.allowInsecureHttp
            // oxlint-disable-next-line typescript/no-deprecated -- This opt-in is restricted to development HTTP.
            ? [client.allowInsecureRequests, client.enableNonRepudiationChecks]
            : [client.enableNonRepudiationChecks],
        },
      )
    } catch (cause) {
      lifetime.abort()
      throw new OidcLoginError('discovery', 'OIDC provider discovery failed; verify the issuer and provider availability.', { cause })
    }
    const metadata = configuration.serverMetadata()
    if (metadata.issuer !== options.issuer) {
      lifetime.abort()
      throw new OidcLoginError('configuration', 'OIDC discovery issuer does not match the configured issuer.')
    }
    for (const [name, value] of [
      ['authorization_endpoint', metadata.authorization_endpoint],
      ['token_endpoint', metadata.token_endpoint],
      ['jwks_uri', metadata.jwks_uri],
    ] as const) {
      if (value === undefined) {
        lifetime.abort()
        throw new OidcLoginError('configuration', `OIDC discovery is missing ${name}.`)
      }
      parseEndpoint(value, options.allowInsecureHttp, name)
    }
    return new OidcLogin(
      configuration,
      lifetime,
      options.issuer,
      redirectUri.href,
      options.allowInsecureHttp,
      options.flowTtlMs,
      options.maxPendingFlows,
    )
  }

  /**
   * Reserves a bounded, expiring authorization attempt tied to one browser cookie.
   * @param returnOrigin Trusted gateway origin to return to after login; callers must enforce their origin allowlist.
   * @returns Provider URL and opaque cookie value; store the cookie as HttpOnly, SameSite=Lax and Secure under HTTPS.
   */
  async begin(returnOrigin: string): Promise<{ authorizationUrl: string; flowCookie: string }> {
    this.assertActive()
    const origin = parseEndpoint(returnOrigin, this.allowInsecureHttp, 'returnOrigin')
    if (origin.origin !== returnOrigin) {
      throw new OidcLoginError('configuration', 'OIDC returnOrigin must be an origin without a path, query, or fragment.')
    }
    this.pruneExpired()
    if (this.flows.size >= this.maxPendingFlows) {
      throw new OidcLoginError('capacity', 'Too many pending OIDC logins; try again after earlier attempts expire.')
    }
    const state = client.randomState()
    const browserBinding = client.randomState()
    const codeVerifier = client.randomPKCECodeVerifier()
    const nonce = client.randomNonce()
    const flow: PendingFlow = {
      browserBinding,
      codeVerifier,
      nonce,
      returnOrigin,
      expiresAt: Date.now() + this.flowTtlMs,
    }
    this.flows.set(state, flow)
    try {
      const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier)
      this.assertActive()
      const authorizationUrl = client.buildAuthorizationUrl(this.configuration, {
        scope: 'openid profile',
        response_type: 'code',
        redirect_uri: this.redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        nonce,
        state,
      }).href
      return { authorizationUrl, flowCookie: browserBinding }
    } catch (cause) {
      this.flows.delete(state)
      throw cause
    }
  }

  /**
   * Consumes an authorization attempt before exchanging its code and verifying its ID token.
   * @param callbackUrl Browser callback on the exact configured callback origin and path.
   * @param flowCookie Cookie issued by begin; missing, incorrect, expired, and replayed cookies are rejected.
   * @returns Validated identity and original return origin; a matched attempt is consumed on success or failure.
   */
  finish(callbackUrl: URL, flowCookie: string | undefined): Promise<{ identity: OidcIdentity; returnOrigin: string }> {
    const operation = this.finishOnce(callbackUrl, flowCookie)
    this.operations.add(operation)
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    )
    return operation
  }

  /**
   * Stops new login operations, clears pending attempts, and aborts and awaits active code exchanges.
   * @returns Completion after this owner can no longer authenticate a request.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.flows.clear()
    await Promise.allSettled([...this.operations])
  }

  private async finishOnce(callbackUrl: URL, flowCookie: string | undefined): Promise<{ identity: OidcIdentity; returnOrigin: string }> {
    this.assertActive()
    const stateValues = callbackUrl.searchParams.getAll('state')
    const state = stateValues.length === 1 ? stateValues[0] : undefined
    if (state === undefined) {
      throw new OidcLoginError('invalid-flow', 'OIDC authorization response must identify one pending login attempt.')
    }
    const flow = this.flows.get(state)
    this.flows.delete(state)
    if (flow === undefined || flow.expiresAt <= Date.now() || flowCookie === undefined || !sameBinding(flowCookie, flow.browserBinding)) {
      throw new OidcLoginError('invalid-flow', 'OIDC login attempt is missing, expired, or belongs to another browser; sign in again.')
    }
    const redirectUri = new URL(this.redirectUri)
    if (callbackUrl.origin !== redirectUri.origin || callbackUrl.pathname !== redirectUri.pathname || callbackUrl.hash) {
      throw new OidcLoginError('invalid-flow', 'OIDC callback does not match the registered redirect URI; sign in again.')
    }
    try {
      const tokens = await client.authorizationCodeGrant(this.configuration, callbackUrl, {
        expectedState: state,
        expectedNonce: flow.nonce,
        pkceCodeVerifier: flow.codeVerifier,
        idTokenExpected: true,
      })
      this.assertActive()
      const claims = tokens.claims()
      if (claims === undefined || typeof claims.sub !== 'string' || !claims.sub.trim()) {
        throw new OidcLoginError('provider', 'OIDC provider did not return a usable subject claim.')
      }
      const name = typeof claims.name === 'string' && claims.name.trim()
        ? claims.name
        : typeof claims.preferred_username === 'string' && claims.preferred_username.trim()
          ? claims.preferred_username
          : claims.sub
      return { identity: { issuer: this.issuer, subject: claims.sub, name }, returnOrigin: flow.returnOrigin }
    } catch (cause) {
      if (cause instanceof OidcLoginError) throw cause
      this.assertActive()
      throw new OidcLoginError('provider', 'OIDC authorization failed; sign in again or contact the administrator.', { cause })
    }
  }

  private assertActive(): void {
    if (this.lifetime.signal.aborted) throw new OidcLoginError('disposed', 'OIDC login is shutting down.')
  }

  private pruneExpired(): void {
    const now = Date.now()
    for (const [state, flow] of this.flows) {
      if (flow.expiresAt <= now) this.flows.delete(state)
    }
  }
}

function parseEndpoint(value: string, allowInsecureHttp: boolean, name: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new OidcLoginError('configuration', `OIDC ${name} must be an absolute URL.`, { cause })
  }
  if ((url.protocol !== 'https:' && !(allowInsecureHttp && url.protocol === 'http:')) || url.username || url.password) {
    throw new OidcLoginError('configuration', `OIDC ${name} requires HTTPS without embedded credentials; HTTP is development-only.`)
  }
  return url
}

function sameBinding(received: string, expected: string): boolean {
  const receivedBytes = Buffer.from(received)
  const expectedBytes = Buffer.from(expected)
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes)
}
