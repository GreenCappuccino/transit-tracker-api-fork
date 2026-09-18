import { Inject, Injectable, Logger, Optional } from "@nestjs/common"
import { Cacheable } from "cacheable"
import crypto from "crypto"
import type Redis from "ioredis"
import { REDIS_CLIENT } from "src/modules/cache/cache.module"
import type { NjTransitAuthConfig } from "../../../config"
import { CredentialsService } from "../../credentials.service"
import { TokenBudgetExhaustedError } from "../../fetch.errors"
import { NjTransitClient } from "./njtransit.client"
import {
  NJT_APIS,
  NJT_LOGIN_BACKOFF_CEILING_MS,
  NJT_LOGIN_BACKOFF_FLOOR_MS,
  NJT_LOGIN_TIMEOUT_MS,
  NJT_PROVIDER,
  NJT_UPSTREAM_DAILY_TOKEN_LIMIT,
} from "./njtransit.const"

/** Long enough to outlive an Eastern day regardless of when it was set. */
const BUDGET_KEY_TTL_SECONDS = 36 * 60 * 60

const LOCK_TTL_MS = 60_000
const LOCK_POLL_INTERVAL_MS = 500
const LOCK_POLL_TIMEOUT_MS = 15_000

/** Redacts a token to something safe to log but still recognisable. */
export function redactToken(token: string): string {
  return `${token.slice(0, 4)}…(${token.length})`
}

interface MemoisedToken {
  token: string
  expiresAt: number
}

/**
 * Holds NJ TRANSIT access tokens and enforces the daily login budget.
 *
 * NJ TRANSIT permits 10 logins per account per day and locks the account out of
 * every endpoint until midnight Eastern once that is exceeded, so the cost of
 * getting this wrong is a day of outage rather than a slow request. Three
 * consequences shape the design:
 *
 *  - State is keyed on the *account*, never on the feed. Two feeds configured
 *    against one NJ TRANSIT account share a token and a budget; keying on the
 *    feed would silently double the spend.
 *  - The counter lives in Redis and is incremented atomically, so it holds
 *    across restarts and across instances. Without Redis it degrades to a
 *    per-process counter, which is announced loudly because it is not a
 *    guarantee.
 *  - The increment happens *before* the request. NJ TRANSIT charges the quota
 *    when the request arrives, so an attempt whose outcome we never learn must
 *    be assumed spent.
 */
@Injectable()
export class NjTransitTokenStore {
  private readonly logger = new Logger(NjTransitTokenStore.name)

  private readonly memo = new Map<string, MemoisedToken>()
  private readonly loginsInFlight = new Map<string, Promise<string>>()
  private readonly localBudget = new Map<string, number>()
  private readonly instanceId = crypto.randomUUID()

  private warnedAboutMissingRedis = false

  constructor(
    private readonly cache: Cacheable,
    private readonly credentials: CredentialsService,
    private readonly client: NjTransitClient,
    @Inject(REDIS_CLIENT) @Optional() private readonly redis?: Redis,
  ) {}

  baseUrlFor(auth: NjTransitAuthConfig): string {
    return auth.baseUrl ?? NJT_APIS[auth.api].baseUrl
  }

  async getToken(auth: NjTransitAuthConfig): Promise<string> {
    const key = await this.accountKey(auth)

    const memoised = this.memo.get(key)
    if (memoised && memoised.expiresAt > Date.now()) {
      return memoised.token
    }

    const cached = await this.cache.get<string>(this.tokenKey(key))
    if (cached) {
      this.memoise(key, cached, auth.tokenMaxAge)
      return cached
    }

    return this.login(key, auth)
  }

  /** Discards the cached token so the next call authenticates afresh. */
  async invalidate(auth: NjTransitAuthConfig): Promise<void> {
    const key = await this.accountKey(auth)
    this.memo.delete(key)
    await this.cache.delete(this.tokenKey(key))
  }

  async forceLogin(auth: NjTransitAuthConfig): Promise<string> {
    return this.login(await this.accountKey(auth), auth)
  }

  /**
   * Identity of the upstream account, derived after credentials are resolved so
   * that the same account reached through different config forms (inline here,
   * a file there) collapses to one token and one budget. The username is
   * hashed; it is never stored or logged in clear.
   */
  private async accountKey(auth: NjTransitAuthConfig): Promise<string> {
    const { username } = await this.credentials.resolve(auth)
    const digest = crypto
      .createHash("sha256")
      .update(`${this.baseUrlFor(auth)}\0${username}`)
      .digest("hex")
      .slice(0, 16)

    return `${auth.api}:${digest}`
  }

  private tokenKey(key: string) {
    return `njtransit:token:${key}`
  }

  private budgetKey(key: string) {
    return `njtransit:budget:${key}:${this.easternDay()}`
  }

  private backoffKey(key: string) {
    return `njtransit:backoff:${key}`
  }

  private lockKey(key: string) {
    return `njtransit:lock:${key}`
  }

  /**
   * The calendar day in NJ TRANSIT's own timezone, which is when their quota
   * resets. en-CA formats as YYYY-MM-DD, and Intl handles the DST transitions.
   */
  private easternDay(): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
    }).format(new Date())
  }

  private memoise(key: string, token: string, ttlMs: number) {
    this.memo.set(key, { token, expiresAt: Date.now() + ttlMs })
  }

  private login(key: string, auth: NjTransitAuthConfig): Promise<string> {
    const existing = this.loginsInFlight.get(key)
    if (existing) {
      return existing
    }

    // .finally() on the chain, so the entry is removed once the promise has
    // settled rather than as soon as this function returns.
    const promise = this.doLogin(key, auth).finally(() => {
      this.loginsInFlight.delete(key)
    })

    this.loginsInFlight.set(key, promise)
    return promise
  }

  private async doLogin(
    key: string,
    auth: NjTransitAuthConfig,
  ): Promise<string> {
    await this.assertNotBackingOff(key, auth)
    await this.assertBudgetAvailable(key, auth)

    const lockAcquired = await this.acquireLock(key)
    if (!lockAcquired) {
      const token = await this.awaitTokenFromOtherInstance(key, auth)
      if (token) {
        return token
      }

      throw new TokenBudgetExhaustedError(
        NJT_PROVIDER,
        `Another instance is authenticating with NJ TRANSIT ${auth.api} and did not publish a token in time.`,
        { api: auth.api },
      )
    }

    try {
      // Charged before the request: NJ TRANSIT counts the call on arrival, so
      // an attempt whose outcome we never learn must be assumed spent.
      const used = await this.chargeBudget(key)
      if (used > auth.dailyTokenBudget) {
        throw this.budgetExhausted(auth, used)
      }

      this.logger.log(
        `Requesting NJ TRANSIT ${auth.api} token (${used}/${auth.dailyTokenBudget} logins used today)`,
      )

      const { username, password } = await this.credentials.resolve(auth)
      const baseUrl = this.baseUrlFor(auth)

      const token = await this.client.login(
        baseUrl,
        NJT_APIS[auth.api].loginOperation,
        username,
        password,
        NJT_LOGIN_TIMEOUT_MS,
      )

      await this.cache.set(this.tokenKey(key), token, auth.tokenMaxAge)
      this.memoise(key, token, auth.tokenMaxAge)
      await this.clearBackoff(key)

      this.logger.log(
        `Obtained NJ TRANSIT ${auth.api} token ${redactToken(token)}`,
      )

      return token
    } catch (err) {
      if (!(err instanceof TokenBudgetExhaustedError)) {
        await this.armBackoff(key, auth)
      }
      throw err
    } finally {
      await this.releaseLock(key)
    }
  }

  private budgetExhausted(auth: NjTransitAuthConfig, used: number) {
    return new TokenBudgetExhaustedError(
      NJT_PROVIDER,
      `NJ TRANSIT ${auth.api} daily token budget exhausted ` +
        `(${used - 1}/${auth.dailyTokenBudget} used for ${this.easternDay()} Eastern). ` +
        `NJ TRANSIT's own hard limit is ${NJT_UPSTREAM_DAILY_TOKEN_LIMIT}/day and exceeding it ` +
        `locks the account out of every endpoint; no further login will be attempted ` +
        `until midnight Eastern.`,
      { api: auth.api, used: used - 1, budget: auth.dailyTokenBudget },
    )
  }

  private async assertBudgetAvailable(
    key: string,
    auth: NjTransitAuthConfig,
  ): Promise<void> {
    const used = await this.readBudget(key)
    if (used >= auth.dailyTokenBudget) {
      // Read-only pre-check so a hot loop cannot inflate the counter past the
      // real number of attempts.
      throw this.budgetExhausted(auth, used + 1)
    }
  }

  private async readBudget(key: string): Promise<number> {
    if (!this.redis) {
      return this.localBudget.get(this.budgetKey(key)) ?? 0
    }

    // Fails closed: if Redis cannot answer, assume the budget is spent rather
    // than risk locking the account out for a day.
    const raw = await this.redis.get(this.budgetKey(key))
    return raw ? Number(raw) : 0
  }

  private async chargeBudget(key: string): Promise<number> {
    const budgetKey = this.budgetKey(key)

    if (!this.redis) {
      this.warnMissingRedisOnce()
      const used = (this.localBudget.get(budgetKey) ?? 0) + 1
      this.localBudget.set(budgetKey, used)
      return used
    }

    const used = await this.redis.incr(budgetKey)
    await this.redis.expire(budgetKey, BUDGET_KEY_TTL_SECONDS)
    return used
  }

  private warnMissingRedisOnce() {
    if (this.warnedAboutMissingRedis) return
    this.warnedAboutMissingRedis = true

    this.logger.error(
      "REDIS_URL is not set, so the NJ TRANSIT daily token budget cannot be " +
        "enforced across restarts or instances. A restart loop can exhaust the " +
        "account's daily quota and lock it out until midnight Eastern.",
    )
  }

  private async assertNotBackingOff(
    key: string,
    auth: NjTransitAuthConfig,
  ): Promise<void> {
    if (!this.redis) return

    const until = await this.redis.pttl(this.backoffKey(key))
    if (until > 0) {
      throw new TokenBudgetExhaustedError(
        NJT_PROVIDER,
        `NJ TRANSIT ${auth.api} login is backing off after a recent failure; ` +
          `retrying in ${Math.ceil(until / 1000)}s.`,
        { api: auth.api, retryInMs: until },
      )
    }
  }

  private async armBackoff(
    key: string,
    auth: NjTransitAuthConfig,
  ): Promise<void> {
    if (!this.redis) return

    const attemptsKey = `${this.backoffKey(key)}:attempts`
    const attempts = await this.redis.incr(attemptsKey)
    await this.redis.expire(attemptsKey, BUDGET_KEY_TTL_SECONDS)

    const delay = Math.min(
      NJT_LOGIN_BACKOFF_FLOOR_MS * 2 ** (attempts - 1),
      NJT_LOGIN_BACKOFF_CEILING_MS,
    )

    await this.redis.set(this.backoffKey(key), "1", "PX", delay)
    this.logger.warn(
      `NJ TRANSIT ${auth.api} login failed; backing off for ${Math.round(delay / 1000)}s`,
    )
  }

  private async clearBackoff(key: string): Promise<void> {
    if (!this.redis) return
    await this.redis.del(
      this.backoffKey(key),
      `${this.backoffKey(key)}:attempts`,
    )
  }

  private async acquireLock(key: string): Promise<boolean> {
    if (!this.redis) return true

    const result = await this.redis.set(
      this.lockKey(key),
      this.instanceId,
      "PX",
      LOCK_TTL_MS,
      "NX",
    )

    return result === "OK"
  }

  private async releaseLock(key: string): Promise<void> {
    if (!this.redis) return

    // Only release a lock we still hold; a lock that expired belongs to whoever
    // took it next.
    const holder = await this.redis.get(this.lockKey(key))
    if (holder === this.instanceId) {
      await this.redis.del(this.lockKey(key))
    }
  }

  /**
   * Waits for whichever instance holds the lock to publish a token, rather than
   * spending a login of our own. Never steals the lock.
   */
  private async awaitTokenFromOtherInstance(
    key: string,
    auth: NjTransitAuthConfig,
  ): Promise<string | null> {
    const deadline = Date.now() + LOCK_POLL_TIMEOUT_MS

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS))

      const token = await this.cache.get<string>(this.tokenKey(key))
      if (token) {
        this.memoise(key, token, auth.tokenMaxAge)
        return token
      }
    }

    return null
  }
}
