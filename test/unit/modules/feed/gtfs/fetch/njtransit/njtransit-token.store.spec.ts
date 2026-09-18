import { Cacheable, createKeyv } from "cacheable"
import type { NjTransitAuthConfig } from "src/modules/feed/modules/gtfs/config"
import { NjTransitTokenStore } from "src/modules/feed/modules/gtfs/fetch/auth/njtransit/njtransit-token.store"
import { NjTransitClient } from "src/modules/feed/modules/gtfs/fetch/auth/njtransit/njtransit.client"
import { CredentialsService } from "src/modules/feed/modules/gtfs/fetch/credentials.service"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FakeRedis } from "../../../../../helpers/fake-redis"

const auth = (
  overrides: Partial<NjTransitAuthConfig> = {},
): NjTransitAuthConfig =>
  ({
    provider: "njtransit",
    api: "rail",
    username: "njt-user",
    password: "njt-pass",
    dailyTokenBudget: 3,
    tokenMaxAge: 20 * 60 * 60 * 1000,
    ...overrides,
  }) as NjTransitAuthConfig

function newCache() {
  return new Cacheable({ primary: createKeyv({ useClone: false }) })
}

describe("NjTransitTokenStore", () => {
  let redis: FakeRedis
  let cache: Cacheable
  let client: NjTransitClient
  let login: ReturnType<typeof vi.fn>

  const build = (
    overrides: { cache?: Cacheable; redis?: FakeRedis | null } = {},
  ) => {
    const useRedis =
      overrides.redis === null ? undefined : (overrides.redis ?? redis)
    return new NjTransitTokenStore(
      overrides.cache ?? cache,
      new CredentialsService(),
      client,
      useRedis?.asRedis(),
    )
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-18T15:00:00Z"))

    redis = new FakeRedis()
    cache = newCache()

    login = vi.fn().mockResolvedValue("NJT-TOKEN-1")
    client = { login } as unknown as NjTransitClient
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("logs in once and reuses the token", async () => {
    const store = build()

    await expect(store.getToken(auth())).resolves.toBe("NJT-TOKEN-1")
    await expect(store.getToken(auth())).resolves.toBe("NJT-TOKEN-1")
    await expect(store.getToken(auth())).resolves.toBe("NJT-TOKEN-1")

    expect(login).toHaveBeenCalledTimes(1)
  })

  it("collapses concurrent cold requests into a single login", async () => {
    let release!: (token: string) => void
    login.mockReturnValue(new Promise<string>((r) => (release = r)))

    const store = build()
    const pending = Array.from({ length: 10 }, () => store.getToken(auth()))

    release("NJT-TOKEN-1")
    await expect(Promise.all(pending)).resolves.toEqual(
      Array(10).fill("NJT-TOKEN-1"),
    )

    expect(login).toHaveBeenCalledTimes(1)
  })

  describe("daily budget", () => {
    it("stops at the configured budget", async () => {
      const store = build()
      const config = auth({ dailyTokenBudget: 3 })

      for (let i = 0; i < 3; i++) {
        await store.forceLogin(config)
      }

      await expect(store.forceLogin(config)).rejects.toMatchObject({
        kind: "unavailable",
        message: expect.stringContaining("daily token budget exhausted"),
      })

      expect(login).toHaveBeenCalledTimes(3)
    })

    // NJ TRANSIT charges the quota when the request arrives, so an attempt we
    // never see the outcome of still has to count.
    it("charges the budget even when the login itself fails", async () => {
      login.mockRejectedValue(new Error("network unreachable"))

      const store = build()
      const config = auth({ dailyTokenBudget: 3 })

      await expect(store.forceLogin(config)).rejects.toThrow()

      const key = Array.from((redis as any).store.keys()).find((k) =>
        String(k).includes("budget"),
      )
      expect(await redis.get(String(key))).toBe("1")
    })

    it("resets after midnight Eastern", async () => {
      const store = build()
      const config = auth({ dailyTokenBudget: 1 })

      // 23:30 Eastern on 2026-09-18 (EDT, UTC-4).
      vi.setSystemTime(new Date("2026-09-19T03:30:00Z"))
      await store.forceLogin(config)
      await expect(store.forceLogin(config)).rejects.toThrow(/budget exhausted/)

      // 00:30 Eastern the following day.
      vi.setSystemTime(new Date("2026-09-19T04:30:00Z"))
      await expect(store.forceLogin(config)).resolves.toBe("NJT-TOKEN-1")

      expect(login).toHaveBeenCalledTimes(2)
    })

    it("keys the budget per account, not per feed", async () => {
      const store = build()

      // Same credentials reached two ways: one inline, one identical value.
      await store.forceLogin(auth({ dailyTokenBudget: 1 }))
      await expect(
        store.forceLogin(auth({ dailyTokenBudget: 1 })),
      ).rejects.toThrow(/budget exhausted/)
    })

    it("gives rail and bus separate budgets", async () => {
      const store = build()

      await store.forceLogin(auth({ api: "rail", dailyTokenBudget: 1 }))
      await expect(
        store.forceLogin(auth({ api: "bus", dailyTokenBudget: 1 })),
      ).resolves.toBe("NJT-TOKEN-1")

      expect(login).toHaveBeenCalledTimes(2)
    })
  })

  describe("across restarts", () => {
    it("reuses a token another process already obtained", async () => {
      await build().getToken(auth())
      expect(login).toHaveBeenCalledTimes(1)

      // A fresh store over the same Redis and cache, as a restart would be.
      await expect(build().getToken(auth())).resolves.toBe("NJT-TOKEN-1")
      expect(login).toHaveBeenCalledTimes(1)
    })

    it("still sees the budget spent when the token cache is lost", async () => {
      const config = auth({ dailyTokenBudget: 1 })
      await build().getToken(config)

      // Token cache emptied, Redis retained -- a cache flush, not a quota reset.
      await expect(
        build({ cache: newCache() }).getToken(config),
      ).rejects.toThrow(/budget exhausted/)
    })
  })

  describe("without Redis", () => {
    it("still enforces a budget within the process", async () => {
      const store = build({ redis: null })
      const config = auth({ dailyTokenBudget: 1 })

      await store.forceLogin(config)
      await expect(store.forceLogin(config)).rejects.toThrow(/budget exhausted/)
    })
  })

  describe("backoff", () => {
    it("refuses to retry immediately after a failure", async () => {
      login.mockRejectedValue(new Error("upstream down"))
      const store = build()

      await expect(store.forceLogin(auth())).rejects.toThrow(/upstream down/)
      await expect(store.forceLogin(auth())).rejects.toThrow(/backing off/)

      // The backed-off attempt must not have cost a login.
      expect(login).toHaveBeenCalledTimes(1)
    })

    it("allows another attempt once the backoff expires", async () => {
      login.mockRejectedValueOnce(new Error("upstream down"))
      const store = build()

      await expect(store.forceLogin(auth())).rejects.toThrow()

      vi.setSystemTime(Date.now() + 6 * 60 * 1000)
      await expect(store.forceLogin(auth())).resolves.toBe("NJT-TOKEN-1")
    })
  })

  it("invalidate discards the cached token", async () => {
    const store = build()

    await store.getToken(auth())
    await store.invalidate(auth())
    await store.getToken(auth())

    expect(login).toHaveBeenCalledTimes(2)
  })
})
