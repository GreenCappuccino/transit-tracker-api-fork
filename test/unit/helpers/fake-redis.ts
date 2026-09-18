import type Redis from "ioredis"

interface Entry {
  value: string
  expiresAt: number | null
}

/**
 * The slice of Redis the NJ TRANSIT token store uses, in memory.
 *
 * Hand-rolled rather than mocked because the behaviour under test *is* the
 * Redis semantics: atomic INCR, SET NX, and key expiry. A mock that returns
 * canned values would assert that we called Redis, not that the budget holds.
 *
 * Honours vitest's fake timers via Date.now(), so expiry can be tested by
 * advancing the clock.
 */
export class FakeRedis {
  private readonly store = new Map<string, Entry>()

  private live(key: string): Entry | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined

    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key)
      return undefined
    }

    return entry
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null
  }

  async set(
    key: string,
    value: string,
    ...args: unknown[]
  ): Promise<"OK" | null> {
    const flags = args.map((a) => String(a).toUpperCase())

    let expiresAt: number | null = null
    const pxIndex = flags.indexOf("PX")
    if (pxIndex !== -1) {
      expiresAt = Date.now() + Number(args[pxIndex + 1])
    }

    if (flags.includes("NX") && this.live(key)) {
      return null
    }

    this.store.set(key, { value, expiresAt })
    return "OK"
  }

  async incr(key: string): Promise<number> {
    const existing = this.live(key)
    const next = Number(existing?.value ?? 0) + 1
    this.store.set(key, {
      value: String(next),
      expiresAt: existing?.expiresAt ?? null,
    })
    return next
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.live(key)
    if (!entry) return 0

    entry.expiresAt = Date.now() + seconds * 1000
    return 1
  }

  async pttl(key: string): Promise<number> {
    const entry = this.live(key)
    if (!entry) return -2
    if (entry.expiresAt === null) return -1
    return entry.expiresAt - Date.now()
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0
    for (const key of keys) {
      if (this.store.delete(key)) deleted++
    }
    return deleted
  }

  /** Test affordance: forget everything, as a restart with no Redis would. */
  flush() {
    this.store.clear()
  }

  asRedis(): Redis {
    return this as unknown as Redis
  }
}
