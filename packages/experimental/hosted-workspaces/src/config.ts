/** Deployment settings for the private Docker workspace gateway. */
import z from '@deepseek-ai/schemastery'

/** Gateway, identity-provider, Docker and model-proxy deployment inputs. */
export interface Config {
  /** Bare portal origin whose direct subdomains host personal workspaces. */
  publicOrigin: string
  /** Locally available Docker image reference used for personal runtimes. */
  image: string
  /** Deployment-specific prefix for owned Docker containers, networks, and volumes. */
  prefix: string
  /** Exact OIDC issuer expected in discovery metadata and validated ID tokens. */
  issuer: string
  /** Internal discovery document URL; omission discovers through the configured issuer. */
  discoveryUrl?: string
  /** Client identifier assigned to this gateway's OIDC application. */
  clientId: string
  /** Gateway-only secret-file path for client_secret_basic; omission selects a public client. */
  clientSecretFile?: string
  /** Gateway-only file containing the upstream model API key. */
  deepseekKeyFile: string
  /** Upstream base URL to which the model proxy appends /v1/messages. */
  deepseekBaseUrl: string
  /** Exact model identifiers admitted by the shared-key model proxy. */
  allowedModels: string[]
  /** Permit development HTTP for the portal, OIDC provider, and model upstream. */
  allowHttp: boolean
  /** Docker daemon Unix-socket path available only to the gateway. */
  dockerSocket: string
  /** Existing gateway container name or ID to attach to personal Docker networks. */
  gatewayContainer: string
  /** Port used by model listeners on the gateway's personal-network addresses. */
  gatewayPort: number
  /** Absolute browser-session lifetime in milliseconds; activity does not extend it. */
  sessionTtlMs: number
  /** Pending OIDC login and private-origin handoff lifetime in milliseconds. */
  flowTtlMs: number
  /** Maximum entries in each pending-login or private-origin handoff collection. */
  maxPendingFlows: number
  /** Maximum enrolled accounts and personal Docker runtime reservations. */
  maxUsers: number
  /** Maximum live browser sessions across all accounts; expired sessions are reclaimed at login. */
  maxBrowserSessions: number
  /** Maximum simultaneous HTTP responses and WebSocket connections across one account's sessions. */
  maxProxyConnectionsPerUser: number
  /** Maximum decoded and modified HTML index response bytes before proxy rejection. */
  maxIndexResponseBytes: number
  /** OIDC HTTP request and complete model-request timeout in milliseconds. */
  requestTimeoutMs: number
  /** Runtime startup budget and Docker API request timeout in milliseconds. */
  startupTimeoutMs: number
  /** Docker memory limit in bytes for each personal container. */
  containerMemoryBytes: number
  /** CPU limit per personal container in nanoCPUs; one CPU is one billion units. */
  containerNanoCpus: number
  /** Docker PID-counted task limit for each personal container. */
  containerPidsLimit: number
  /** Size limit in bytes of each personal container's /tmp tmpfs. */
  containerTmpBytes: number
  /** Web-profile port inside personal containers; no host port is published. */
  runtimePort: number
  /** Maximum complete model-request body bytes before JSON parsing or upstream access. */
  maxModelRequestBytes: number
  /** Maximum max_tokens value accepted in a model request. */
  maxOutputTokens: number
  /** Maximum admitted model requests per account in one rate window. */
  maxRequestsPerWindow: number
  /** Per-account model-request counting window in milliseconds. */
  rateWindowMs: number
  /** Maximum active model requests per account, including body reads and upstream streaming. */
  maxConcurrentModelRequests: number
}

/** Validated configuration; all operational limits can be set by deployment. */
export const Config: z<Partial<Config>, Config> = z.object({
  publicOrigin: z.string().required(),
  image: z.string().required(),
  prefix: z.string().default('dsh-hosted'),
  issuer: z.string().required(),
  discoveryUrl: z.string(),
  clientId: z.string().required(),
  clientSecretFile: z.string(),
  deepseekKeyFile: z.string().required(),
  deepseekBaseUrl: z.string().default('https://api.deepseek.com/anthropic'),
  allowedModels: z.array(String).default(['deepseek-flash', 'deepseek-v4-pro']),
  allowHttp: z.boolean().default(false),
  dockerSocket: z.string().default('/var/run/docker.sock'),
  gatewayContainer: z.string().required(),
  gatewayPort: z.natural().min(1).max(65535).default(8080),
  sessionTtlMs: z.natural().min(1).max(2147483647).default(43200000),
  flowTtlMs: z.natural().min(1).max(2147483647).default(300000),
  maxPendingFlows: z.natural().min(1).default(100),
  maxUsers: z.natural().min(1).default(20),
  maxBrowserSessions: z.natural().min(1).default(200),
  maxProxyConnectionsPerUser: z.natural().min(1).default(64),
  maxIndexResponseBytes: z.natural().min(1).default(2097152),
  requestTimeoutMs: z.natural().min(1).max(2147483647).default(300000),
  startupTimeoutMs: z.natural().min(1).max(2147483647).default(120000),
  containerMemoryBytes: z.natural().min(1).default(2147483648),
  containerNanoCpus: z.natural().min(1).default(2000000000),
  containerPidsLimit: z.natural().min(1).default(256),
  containerTmpBytes: z.natural().min(1).default(268435456),
  runtimePort: z.natural().min(1).max(65535).default(3080),
  maxModelRequestBytes: z.natural().min(1).default(33554432),
  maxOutputTokens: z.natural().min(1).default(256000),
  maxRequestsPerWindow: z.natural().min(1).default(30),
  rateWindowMs: z.natural().min(1).max(2147483647).default(60000),
  maxConcurrentModelRequests: z.natural().min(1).default(2),
})

/**
 * Validate the public entry and derive its canonical origin.
 * @param config - deployment inputs.
 * @returns the root origin; user origins are its direct subdomains.
 */
export function publicOrigin(config: Config): URL {
  const url = new URL(config.publicOrigin)
  if ((url.protocol !== 'https:' && !(config.allowHttp && url.protocol === 'http:'))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('hosted-workspaces: publicOrigin requires a bare HTTPS origin; HTTP requires allowHttp')
  }
  if (!/^[a-z0-9.-]+$/u.test(url.hostname) || !url.hostname.includes('.') || /^[0-9.]+$/u.test(url.hostname)) {
    throw new Error('hosted-workspaces: publicOrigin requires a DNS name supporting user subdomains')
  }
  if (!/^[a-z][a-z0-9-]{0,30}$/u.test(config.prefix)) throw new Error('hosted-workspaces: invalid Docker resource prefix')
  if (config.allowedModels.length === 0) throw new Error('hosted-workspaces: allowedModels must not be empty')
  const upstream = new URL(config.deepseekBaseUrl)
  if ((upstream.protocol !== 'https:' && !(config.allowHttp && upstream.protocol === 'http:'))
    || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error('hosted-workspaces: invalid model upstream')
  }
  return url
}
