import type { NjTransitAuthConfig } from "src/modules/feed/modules/gtfs/config"
import type { NjTransitTokenStore } from "src/modules/feed/modules/gtfs/fetch/auth/njtransit/njtransit-token.store"
import { NjTransitClient } from "src/modules/feed/modules/gtfs/fetch/auth/njtransit/njtransit.client"
import { NJT_APIS } from "src/modules/feed/modules/gtfs/fetch/auth/njtransit/njtransit.const"
import { NjTransitAuthStrategy } from "src/modules/feed/modules/gtfs/fetch/auth/njtransit/njtransit.strategy"
import {
  AuthUpstreamError,
  TokenRejectedError,
} from "src/modules/feed/modules/gtfs/fetch/fetch.errors"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const RAIL = NJT_APIS.rail.baseUrl

const auth = (
  overrides: Partial<NjTransitAuthConfig> = {},
): NjTransitAuthConfig =>
  ({
    provider: "njtransit",
    api: "rail",
    username: "u",
    password: "p",
    dailyTokenBudget: 6,
    tokenMaxAge: 1000,
    ...overrides,
  }) as NjTransitAuthConfig

describe("NjTransitClient", () => {
  let globalFetch: ReturnType<typeof vi.fn>
  let client: NjTransitClient

  beforeEach(() => {
    globalFetch = vi.fn()
    vi.stubGlobal("fetch", globalFetch)
    client = new NjTransitClient()
  })

  afterEach(() => vi.unstubAllGlobals())

  const octetStream = (body = "payload") =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    })

  it("posts credentials as multipart form data", async () => {
    globalFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ Authenticated: "True", UserToken: "TOK" }),
        {
          headers: { "content-type": "application/json" },
        },
      ),
    )

    await expect(
      client.login(RAIL, "getToken", "user", "pass", 1000),
    ).resolves.toBe("TOK")

    const [url, init] = globalFetch.mock.calls[0]
    expect(url).toBe(`${RAIL}/getToken`)
    expect(init.method).toBe("POST")
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.body as FormData).get("username")).toBe("user")
    expect((init.body as FormData).get("password")).toBe("pass")
  })

  it("treats Authenticated=False as a failure even on HTTP 200", async () => {
    globalFetch.mockResolvedValue(
      new Response(JSON.stringify({ Authenticated: "False", UserToken: "" }), {
        headers: { "content-type": "application/json" },
      }),
    )

    await expect(
      client.login(RAIL, "getToken", "user", "bad", 1000),
    ).rejects.toBeInstanceOf(AuthUpstreamError)
  })

  it("reports the literal Null body clearly", async () => {
    globalFetch.mockResolvedValue(
      new Response("Null", { headers: { "content-type": "text/plain" } }),
    )

    await expect(client.login(RAIL, "getToken", "", "", 1000)).rejects.toThrow(
      /unparseable response/,
    )
  })

  it("sends the token and leaves the response body unread", async () => {
    globalFetch.mockResolvedValue(octetStream())

    const response = await client.call(RAIL, "getTripUpdates", "TOK")

    expect((globalFetch.mock.calls[0][1].body as FormData).get("token")).toBe(
      "TOK",
    )
    expect(response.bodyUsed).toBe(false)
  })

  // NJ TRANSIT signals a bad token with a JSON body, not a status code.
  it("classifies a JSON token error as a rejection", async () => {
    globalFetch.mockResolvedValue(
      new Response(JSON.stringify({ errorMessage: "Invalid token." }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    )

    await expect(
      client.call(RAIL, "getTripUpdates", "TOK"),
    ).rejects.toBeInstanceOf(TokenRejectedError)
  })

  it("classifies a non-token JSON error as an upstream failure", async () => {
    globalFetch.mockResolvedValue(
      new Response(JSON.stringify({ errorMessage: "Something else broke." }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    )

    const err = await client.call(RAIL, "getTripUpdates", "TOK").catch((e) => e)
    expect(err).toBeInstanceOf(AuthUpstreamError)
    expect(err).not.toBeInstanceOf(TokenRejectedError)
  })
})

describe("NjTransitAuthStrategy", () => {
  let tokens: NjTransitTokenStore
  let client: NjTransitClient
  let call: ReturnType<typeof vi.fn>
  let forceLogin: ReturnType<typeof vi.fn>
  let strategy: NjTransitAuthStrategy

  beforeEach(() => {
    call = vi.fn().mockResolvedValue(new Response("ok"))
    forceLogin = vi.fn().mockResolvedValue("TOKEN-2")

    tokens = {
      baseUrlFor: () => RAIL,
      getToken: vi.fn().mockResolvedValue("TOKEN-1"),
      invalidate: vi.fn().mockResolvedValue(undefined),
      forceLogin,
    } as unknown as NjTransitTokenStore

    client = { call } as unknown as NjTransitClient
    strategy = new NjTransitAuthStrategy(tokens, client)
  })

  it("declares that its transport cannot answer metadata probes", () => {
    expect(strategy.capabilities).toEqual({ head: false, validators: false })
  })

  it("derives the operation from the configured URL", async () => {
    await strategy.fetch(auth(), { url: `${RAIL}/getTripUpdates` }, {})

    expect(call).toHaveBeenCalledWith(RAIL, "getTripUpdates", "TOKEN-1", {})
  })

  it("re-authenticates once when the token is rejected", async () => {
    call
      .mockRejectedValueOnce(
        new TokenRejectedError("njtransit", "Invalid token."),
      )
      .mockResolvedValueOnce(new Response("ok"))

    await strategy.fetch(auth(), { url: `${RAIL}/getGTFS` }, {})

    expect(tokens.invalidate).toHaveBeenCalled()
    expect(forceLogin).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenNthCalledWith(2, RAIL, "getGTFS", "TOKEN-2", {})
  })

  it("gives up after a second rejection rather than looping", async () => {
    call.mockRejectedValue(
      new TokenRejectedError("njtransit", "Invalid token."),
    )

    await expect(
      strategy.fetch(auth(), { url: `${RAIL}/getGTFS` }, {}),
    ).rejects.toBeInstanceOf(TokenRejectedError)

    expect(forceLogin).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledTimes(2)
  })

  // The guard that stops a bad day at NJ TRANSIT from burning the daily budget.
  it("does not re-authenticate for a non-token failure", async () => {
    call.mockRejectedValue(
      new AuthUpstreamError("njtransit", "getGTFS", "Something else broke."),
    )

    await expect(
      strategy.fetch(auth(), { url: `${RAIL}/getGTFS` }, {}),
    ).rejects.toBeInstanceOf(AuthUpstreamError)

    expect(forceLogin).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledTimes(1)
  })
})
