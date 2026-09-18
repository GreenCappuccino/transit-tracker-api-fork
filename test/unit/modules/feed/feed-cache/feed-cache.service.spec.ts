import { Cacheable, createKeyv } from "cacheable"
import { FeedCacheService } from "src/modules/feed/modules/feed-cache/feed-cache.service"
import { describe, expect, it, vi } from "vitest"

function makeService() {
  const cache = new Cacheable({ primary: createKeyv({ useClone: false }) })
  return new FeedCacheService(cache, { feedCode: "testfeed" } as any)
}

describe("FeedCacheService", () => {
  it("caches a value across sequential calls", async () => {
    const service = makeService()
    const factory = vi.fn().mockResolvedValue("value")

    await expect(service.cached("key", factory)).resolves.toBe("value")
    await expect(service.cached("key", factory)).resolves.toBe("value")

    expect(factory).toHaveBeenCalledTimes(1)
  })

  // The single-flight guarantee: without it, every concurrent miss performs its
  // own upstream fetch. That is merely wasteful for most feeds, but a provider
  // with a request budget can be driven over its limit by one burst of traffic.
  it("collapses concurrent misses into a single call", async () => {
    const service = makeService()

    let release!: (value: string) => void
    const factory = vi
      .fn()
      .mockReturnValue(new Promise<string>((resolve) => (release = resolve)))

    const pending = Array.from({ length: 10 }, () =>
      service.cached("key", factory),
    )

    release("value")
    await expect(Promise.all(pending)).resolves.toEqual(Array(10).fill("value"))

    expect(factory).toHaveBeenCalledTimes(1)
  })

  it("stops de-duplicating once the call has settled", async () => {
    const service = makeService()
    const factory = vi.fn().mockRejectedValue(new Error("upstream down"))

    await expect(service.cached("key", factory)).rejects.toThrow(
      "upstream down",
    )
    await expect(service.cached("key", factory)).rejects.toThrow(
      "upstream down",
    )

    // A failure is not cached, so the second call must reach the factory again
    // rather than being served a rejected promise forever.
    expect(factory).toHaveBeenCalledTimes(2)
  })
})
