import { Injectable } from "@nestjs/common"
import type { FetchConfig } from "../config"
import {
  PLAIN_HTTP_CAPABILITIES,
  type FetchInit,
  type TransportCapabilities,
} from "./auth/auth-strategy.interface"
import { AuthStrategyRegistry } from "./auth/auth-strategy.registry"

/**
 * The single place a configured resource becomes an HTTP response.
 *
 * Intentionally a singleton, and intentionally ignorant of the feed it is
 * serving. Authentication state belongs to an *account*, not to a feed or a
 * request: two feeds may share one upstream account, and a provider's rate
 * limits apply across all of them. Injecting anything feed-scoped here would
 * partition that state per feed and quietly multiply the load on the upstream.
 *
 * Everything it needs already travels in the `FetchConfig`.
 */
@Injectable()
export class FetchService {
  constructor(private readonly registry: AuthStrategyRegistry) {}

  async fetch(config: FetchConfig, init: FetchInit = {}): Promise<Response> {
    // Config headers win over caller headers, matching the behaviour of the
    // call sites this replaced.
    const headers = { ...(init.headers ?? {}), ...(config.headers ?? {}) }

    if (!config.auth) {
      return fetch(config.url, {
        method: init.method ?? "GET",
        headers,
        signal: init.signal,
      })
    }

    return this.registry
      .get(config.auth.provider)
      .fetch(config.auth, config, { ...init, headers })
  }

  capabilities(config: FetchConfig): TransportCapabilities {
    return config.auth
      ? this.registry.get(config.auth.provider).capabilities
      : PLAIN_HTTP_CAPABILITIES
  }
}
