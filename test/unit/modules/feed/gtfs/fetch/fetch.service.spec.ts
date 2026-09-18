import type { FetchConfig } from "src/modules/feed/modules/gtfs/config"
import type { AuthStrategy } from "src/modules/feed/modules/gtfs/fetch/auth/auth-strategy.interface"
import { AuthStrategyRegistry } from "src/modules/feed/modules/gtfs/fetch/auth/auth-strategy.registry"
import { FetchService } from "src/modules/feed/modules/gtfs/fetch/fetch.service"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const njtAuth = {
  provider: "njtransit",
  api: "rail",
  username: "u",
  password: "p",
  dailyTokenBudget: 6,
  tokenMaxAge: 1000,
} as unknown as NonNullable<FetchConfig["auth"]>

describe("FetchService", () => {
  let globalFetch: ReturnType<typeof vi.fn>
  let strategy: AuthStrategy
  let service: FetchService

  beforeEach(() => {
    globalFetch = vi.fn().mockResolvedValue(new Response("ok"))
    vi.stubGlobal("fetch", globalFetch)

    strategy = {
      provider: "njtransit",
      capabilities: { head: false, validators: false },
      fetch: vi.fn().mockResolvedValue(new Response("authed")),
    } as unknown as AuthStrategy

    service = new FetchService(new AuthStrategyRegistry([strategy]))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe("without auth", () => {
    // The contract that keeps this change invisible to every existing feed.
    it("issues exactly the request the old call sites issued", async () => {
      await service.fetch({ url: "https://example.com/feed.zip" })

      expect(globalFetch).toHaveBeenCalledWith("https://example.com/feed.zip", {
        method: "GET",
        headers: {},
        signal: undefined,
      })
    })

    it("passes through method and signal", async () => {
      const signal = AbortSignal.timeout(1000)
      await service.fetch(
        { url: "https://example.com" },
        { method: "HEAD", signal },
      )

      expect(globalFetch).toHaveBeenCalledWith("https://example.com", {
        method: "HEAD",
        headers: {},
        signal,
      })
    })

    it("lets config headers win over caller headers", async () => {
      await service.fetch(
        {
          url: "https://example.com",
          headers: { "User-Agent": "from-config" },
        },
        { headers: { "User-Agent": "from-caller", Accept: "*/*" } },
      )

      expect(globalFetch).toHaveBeenCalledWith(
        "https://example.com",
        expect.objectContaining({
          headers: { Accept: "*/*", "User-Agent": "from-config" },
        }),
      )
    })

    it("does not consume the response body", async () => {
      const response = await service.fetch({ url: "https://example.com" })
      expect(response.bodyUsed).toBe(false)
    })
  })

  describe("with auth", () => {
    it("delegates to the registered strategy and never calls fetch itself", async () => {
      const config: FetchConfig = { url: "https://example.com", auth: njtAuth }
      await service.fetch(config, { method: "GET" })

      expect(globalFetch).not.toHaveBeenCalled()
      expect(strategy.fetch).toHaveBeenCalledWith(
        njtAuth,
        config,
        expect.objectContaining({ method: "GET" }),
      )
    })

    it("throws a configuration error for an unregistered provider", () => {
      const empty = new FetchService(new AuthStrategyRegistry([]))
      expect(() =>
        empty.capabilities({ url: "https://example.com", auth: njtAuth }),
      ).toThrow(/No authentication strategy registered/)
    })
  })

  describe("capabilities", () => {
    it("reports full HTTP capabilities without auth", () => {
      expect(service.capabilities({ url: "https://example.com" })).toEqual({
        head: true,
        validators: true,
      })
    })

    it("reports the strategy's capabilities with auth", () => {
      expect(
        service.capabilities({ url: "https://example.com", auth: njtAuth }),
      ).toEqual({ head: false, validators: false })
    })
  })
})
