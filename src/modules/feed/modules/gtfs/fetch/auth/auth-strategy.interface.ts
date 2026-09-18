import type { AuthConfig, FetchConfig } from "../../config"

export interface FetchInit {
  method?: "GET" | "HEAD"
  headers?: Record<string, string>
  signal?: AbortSignal
}

/**
 * What a transport can tell us about a resource without transferring its body.
 *
 * Plain HTTP can answer both. A provider whose API is POST-only can answer
 * neither, and the sync path uses that to avoid probing for metadata it is
 * never going to get.
 */
export interface TransportCapabilities {
  /** A HEAD request is meaningful. */
  head: boolean
  /** Last-Modified / ETag are obtainable without downloading the body. */
  validators: boolean
}

export const PLAIN_HTTP_CAPABILITIES: TransportCapabilities = {
  head: true,
  validators: true,
}

export interface AuthStrategy<TAuth extends AuthConfig = AuthConfig> {
  readonly provider: TAuth["provider"]
  readonly capabilities: TransportCapabilities

  /**
   * Performs the request, applying whatever authentication `auth` describes.
   *
   * Implementations MUST return the response with its body unread: callers
   * stream multi-hundred-megabyte archives through it. Read the body only on
   * an error path, where the response is being discarded anyway.
   */
  fetch(auth: TAuth, config: FetchConfig, init: FetchInit): Promise<Response>
}

export const AUTH_STRATEGIES = Symbol("AUTH_STRATEGIES")
