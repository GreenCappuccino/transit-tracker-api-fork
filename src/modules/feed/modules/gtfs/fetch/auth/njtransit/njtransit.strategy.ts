import { Injectable, Logger } from "@nestjs/common"
import type { FetchConfig, NjTransitAuthConfig } from "../../../config"
import { TokenRejectedError } from "../../fetch.errors"
import type {
  AuthStrategy,
  FetchInit,
  TransportCapabilities,
} from "../auth-strategy.interface"
import { NjTransitTokenStore, redactToken } from "./njtransit-token.store"
import { NjTransitClient } from "./njtransit.client"
import { NJT_PROVIDER } from "./njtransit.const"

@Injectable()
export class NjTransitAuthStrategy implements AuthStrategy<NjTransitAuthConfig> {
  private readonly logger = new Logger(NjTransitAuthStrategy.name)

  readonly provider = NJT_PROVIDER

  /**
   * Every NJ TRANSIT operation is a POST, so there is nothing a HEAD could be
   * sent to and no way to learn a resource's age without downloading it. The
   * sync path reads this and skips the probe entirely rather than paying for a
   * request that cannot answer.
   */
  readonly capabilities: TransportCapabilities = {
    head: false,
    validators: false,
  }

  constructor(
    private readonly tokens: NjTransitTokenStore,
    private readonly client: NjTransitClient,
  ) {}

  async fetch(
    auth: NjTransitAuthConfig,
    config: FetchConfig,
    init: FetchInit,
  ): Promise<Response> {
    const baseUrl = this.tokens.baseUrlFor(auth)
    const operation = this.operationFrom(config.url, baseUrl)

    const token = await this.tokens.getToken(auth)

    try {
      return await this.client.call(baseUrl, operation, token, init)
    } catch (err) {
      // Only a rejected token justifies spending another login. Anything else
      // -- an upstream 500, a timeout -- must not, or a bad day at NJ TRANSIT
      // burns the whole daily budget.
      if (!(err instanceof TokenRejectedError)) {
        throw err
      }

      this.logger.warn(
        `NJ TRANSIT rejected token ${redactToken(token)} for ${operation}; re-authenticating`,
      )

      await this.tokens.invalidate(auth)
      const refreshed = await this.tokens.forceLogin(auth)

      // Exactly one retry. A second rejection is a real failure.
      return this.client.call(baseUrl, operation, refreshed, init)
    }
  }

  /**
   * The configured URL names the operation; everything before it is the base.
   * Accepting a full URL keeps the config self-describing and consistent with
   * every other feed, rather than inventing an operation-name field.
   */
  private operationFrom(url: string, baseUrl: string): string {
    const trimmedBase = baseUrl.replace(/\/+$/, "")
    if (url.startsWith(`${trimmedBase}/`)) {
      return url.slice(trimmedBase.length + 1)
    }

    // Fall back to the last path segment so a host-shaped baseUrl override
    // still works.
    return new URL(url).pathname.split("/").filter(Boolean).pop() ?? ""
  }
}
