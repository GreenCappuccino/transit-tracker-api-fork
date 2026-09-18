import { Injectable } from "@nestjs/common"
import { AuthUpstreamError, TokenRejectedError } from "../../fetch.errors"
import type { FetchInit } from "../auth-strategy.interface"
import { NJT_PROVIDER } from "./njtransit.const"

/**
 * Raw transport for NJ TRANSIT's API. Performs requests and classifies
 * responses; holds no state and makes no decisions about tokens.
 */
@Injectable()
export class NjTransitClient {
  /**
   * Issues a data request and returns the response with its body unread.
   *
   * NJ TRANSIT signals a rejected token with an `application/json` body rather
   * than a status code (observed: HTTP 500 with
   * `{"errorMessage":"Invalid token."}`), while a successful call returns an
   * octet-stream. Content type is therefore what distinguishes the two, and a
   * non-token error must NOT be reported as a token rejection or an upstream
   * outage would burn the daily login budget re-authenticating.
   */
  async call(
    baseUrl: string,
    operation: string,
    token: string,
    init: FetchInit = {},
  ): Promise<Response> {
    const body = new FormData()
    body.set("token", token)

    const response = await this.post(`${baseUrl}/${operation}`, body, init)

    const contentType = response.headers.get("content-type") ?? ""
    if (this.looksTextual(contentType)) {
      const detail = await this.readErrorDetail(response)

      if (/token/i.test(detail)) {
        throw new TokenRejectedError(NJT_PROVIDER, detail)
      }

      throw new AuthUpstreamError(NJT_PROVIDER, operation, detail, {
        status: response.status,
      })
    }

    if (!response.ok) {
      throw new AuthUpstreamError(
        NJT_PROVIDER,
        operation,
        `HTTP ${response.status} ${response.statusText}`,
        { status: response.status },
      )
    }

    return response
  }

  /** Exchanges credentials for a token. */
  async login(
    baseUrl: string,
    operation: string,
    username: string,
    password: string,
    timeoutMs: number,
  ): Promise<string> {
    const body = new FormData()
    body.set("username", username)
    body.set("password", password)

    const response = await this.post(`${baseUrl}/${operation}`, body, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "text/plain" },
    })

    const text = await response.text()

    let parsed: any
    try {
      parsed = JSON.parse(text)
    } catch {
      // NJ TRANSIT answers a malformed login with the literal body `Null`.
      throw new AuthUpstreamError(
        NJT_PROVIDER,
        operation,
        `unparseable response: ${text.slice(0, 200)}`,
        { status: response.status },
      )
    }

    if (parsed?.errorMessage) {
      throw new AuthUpstreamError(
        NJT_PROVIDER,
        operation,
        parsed.errorMessage,
        {
          status: response.status,
        },
      )
    }

    // Authentication failure is reported in the body, not the status.
    if (
      String(parsed?.Authenticated).toLowerCase() !== "true" ||
      !parsed?.UserToken
    ) {
      throw new AuthUpstreamError(
        NJT_PROVIDER,
        operation,
        `credentials rejected (Authenticated=${parsed?.Authenticated})`,
        { status: response.status },
      )
    }

    return parsed.UserToken
  }

  private async post(
    url: string,
    body: FormData,
    init: FetchInit,
  ): Promise<Response> {
    try {
      return await fetch(url, {
        method: "POST",
        body,
        headers: { accept: "*/*", ...(init.headers ?? {}) },
        signal: init.signal,
      })
    } catch (err: any) {
      throw new AuthUpstreamError(NJT_PROVIDER, "request", err.message, { url })
    }
  }

  private looksTextual(contentType: string): boolean {
    return /json|text\//i.test(contentType)
  }

  private async readErrorDetail(response: Response): Promise<string> {
    const text = await response.text()
    try {
      return JSON.parse(text)?.errorMessage ?? text.slice(0, 200)
    } catch {
      return text.slice(0, 200)
    }
  }
}
