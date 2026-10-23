/** Deployment settings for the private Docker workspace gateway. */
import z from '@deepseek-ai/schemastery'
import type { OidcFlow } from './oidc.ts'

/** Gateway, identity-provider, Docker and model-proxy deployment inputs. */
export interface Config {
  /** Bare portal origin whose direct subdomains host personal workspaces. */
  publicOrigin: string
  /** Locally available Docker image reference used for personal runtimes. */
  image: string
  /** Absolute normalized Linux daemon-host directory mounted read-only at /opt/dsh/resources; omission adds no shared mount. */
  sharedResourcesPath?: string
  /** Deployment-specific prefix for owned Docker containers, networks, and volumes. */
  prefix: string
  /** Exact OIDC issuer expected in discovery metadata and validated ID tokens. */
  issuer: string
  /** Internal discovery document URL; omission discovers through the configured issuer. */
  discoveryUrl?: string
  /** Client identifier assigned to this gateway's OIDC application. */
  clientId: string
  /** OIDC response flow; implicit accepts a signed ID token through the portal callback. */
  oidcFlow: OidcFlow
  /** Verified ID-token claim containing the person's display name. */
  oidcNameClaim: string
  /** Verified ID-token claim containing the account code shown beside the name. */
  oidcCodeClaim: string
  /** Gateway-only client_secret_basic secret file for authorization-code; implicit does not read it. */
  clientSecretFile?: string
  /** Wire protocol admitted by the private model proxy. */
  modelProtocol: 'anthropic-messages' | 'openai-responses'
  /** Gateway-only upstream key file; required for OpenAI Responses and preferred for new deployments. */
  modelKeyFile?: string
  /** Protocol API base; Responses appends /responses, Messages appends /v1/messages. */
  modelBaseUrl?: string
  /** Default personal-runtime model; Responses requires an identifier in allowedModels. */
  runtimeModel?: string
  /** Deployment context budget advertised by the personal Responses route. */
  runtimeContextWindow: number
  /** Per-request output-token budget configured on the personal Responses route. */
  runtimeMaxTokens: number
  /** Optional image-owned runtime overlay beneath /opt/dsh; user-writable paths are not accepted. */
  runtimePatchFile?: string
  /** Legacy Messages key file, used only when modelKeyFile is absent. */
  deepseekKeyFile?: string
  /** Legacy Messages API base, used only when modelBaseUrl is absent. */
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
  /** Maximum entries per pending-login/handoff collection and concurrent implicit callback body reads. */
  maxPendingFlows: number
  /** Maximum implicit callback body bytes before token parsing and verification. */
  maxCallbackBytes: number
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
  /** Maximum protocol output-token limit accepted in a model request. */
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
  sharedResourcesPath: z.string().pattern(/^\/(?!\.{1,2}(?:\/|$))[^/\\\p{Cc}]+(?:\/(?!\.{1,2}(?:\/|$))[^/\\\p{Cc}]+)*$/u),
  prefix: z.string().default('dsh-hosted'),
  issuer: z.string().required(),
  discoveryUrl: z.string(),
  clientId: z.string().required(),
  oidcFlow: z.union(['authorization-code', 'implicit']).default('authorization-code'),
  oidcNameClaim: z.string().pattern(/^\S+$/u).default('name'),
  oidcCodeClaim: z.string().pattern(/^\S+$/u).default('preferred_username'),
  clientSecretFile: z.string(),
  modelProtocol: z.union(['anthropic-messages', 'openai-responses']).default('anthropic-messages'),
  modelKeyFile: z.string(),
  modelBaseUrl: z.string(),
  runtimeModel: z.string(),
  runtimeContextWindow: z.natural().min(1).default(32768),
  runtimeMaxTokens: z.natural().min(1).default(8192),
  runtimePatchFile: z.string().pattern(/^\/opt\/dsh\/(?!\.{1,2}(?:\/|$))[^/\\\p{Cc}]+(?:\/(?!\.{1,2}(?:\/|$))[^/\\\p{Cc}]+)*$/u),
  deepseekKeyFile: z.string(),
  deepseekBaseUrl: z.string().default('https://api.deepseek.com/anthropic'),
  allowedModels: z.array(String).default(['deepseek-flash', 'deepseek-v4-pro']),
  allowHttp: z.boolean().default(false),
  dockerSocket: z.string().default('/var/run/docker.sock'),
  gatewayContainer: z.string().required(),
  gatewayPort: z.natural().min(1).max(65535).default(8080),
  sessionTtlMs: z.natural().min(1).max(2147483647).default(43200000),
  flowTtlMs: z.natural().min(1).max(2147483647).default(300000),
  maxPendingFlows: z.natural().min(1).default(100),
  maxCallbackBytes: z.natural().min(1).default(65536),
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

/** Resolved gateway-only model route; runtime credentials never contain its key. */
export interface ResolvedModel {
  /** Selected request protocol. */
  protocol: Config['modelProtocol']
  /** Gateway-only upstream credential file. */
  keyFile: string
  /** Validated API base without a trailing slash. */
  baseUrl: string
}

/**
 * Resolve explicit model settings and the existing Messages deployment defaults.
 * @param config - deployment inputs.
 * @returns validated protocol, secret-file path, and API base.
 */
export function resolveModel(config: Config): ResolvedModel {
  if (config.modelProtocol === 'openai-responses' && (!config.modelKeyFile || !config.modelBaseUrl)) {
    throw new Error('hosted-workspaces: openai-responses requires modelKeyFile and modelBaseUrl')
  }
  if (config.modelProtocol === 'openai-responses') {
    if (config.runtimeModel === undefined || !config.allowedModels.includes(config.runtimeModel)) {
      throw new Error('hosted-workspaces: openai-responses requires runtimeModel in allowedModels')
    }
    if (config.runtimeMaxTokens > config.maxOutputTokens || config.runtimeMaxTokens > config.runtimeContextWindow) {
      throw new Error('hosted-workspaces: runtimeMaxTokens exceeds the proxy or runtime context limit')
    }
  }
  const keyFile = config.modelKeyFile ?? config.deepseekKeyFile
  if (!keyFile?.trim()) throw new Error('hosted-workspaces: modelKeyFile is required')
  const upstream = new URL(config.modelBaseUrl ?? config.deepseekBaseUrl)
  if ((upstream.protocol !== 'https:' && !(config.allowHttp && upstream.protocol === 'http:'))
    || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error('hosted-workspaces: invalid model upstream')
  }
  return { protocol: config.modelProtocol, keyFile, baseUrl: upstream.href.replace(/\/$/u, '') }
}

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
  resolveModel(config)
  return url
}
