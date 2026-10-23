/** Authenticated extension requests from one gateway-owned personal runtime. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostedUserId } from './state.ts'

/** Verified SSO identity without browser, runtime, or upstream credentials. */
export interface HostedRuntimeActor {
  readonly id: HostedUserId
  readonly issuer: string
  readonly subject: string
}

/** One request whose lifetime belongs to the hosted runtime listener. */
export interface HostedRuntimeRequest {
  readonly actor: HostedRuntimeActor
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly signal: AbortSignal
  /** Check again immediately before releasing protected data; logout and expiry revoke access. */
  readonly isActive: () => boolean
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Serve an optional operation under /runtime/ after runtime credential and live-login checks.
     * A handler owns its response only when returning true; other paths delegate to next().
     * Each provider must authorize its own resources and recheck isActive before publishing data.
     * @param request - verified identity, response, cancellation, and current login check.
     * @param next - delegate an unhandled path; the terminal continuation returns false.
     * @mode waterfall
     */
    'hosted-workspaces/runtime-request'(request: HostedRuntimeRequest, next: () => Promise<boolean>): Promise<boolean>
  }
}
