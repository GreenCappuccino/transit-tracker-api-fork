/**
 * NJ TRANSIT runs rail and bus as two separate APIs: different hosts, different
 * login operation names, and separate accounts with separate daily budgets.
 *
 * Both are HTTP POST with multipart/form-data bodies. The login takes
 * `username` and `password` and answers with JSON; every other operation takes
 * a `token` field and answers with an octet-stream.
 *
 * Documentation is distributed to registered developers; register at
 * https://developer.njtransit.com/registration
 */
export const NJT_APIS = {
  rail: {
    baseUrl: "https://raildata.njtransit.com/api/GTFSRT",
    loginOperation: "getToken",
  },
  bus: {
    baseUrl: "https://pcsdata.njtransit.com/api/GTFSG2",
    loginOperation: "authenticateUser",
  },
} as const

export type NjTransitApi = keyof typeof NJT_APIS

export const NJT_PROVIDER = "njtransit"

/**
 * NJ TRANSIT's own hard limit on login calls per account per day. Exceeding it
 * locks the account out of every endpoint until midnight Eastern, so nothing
 * here should ever approach it; it exists to document what the configured
 * budget is a fraction of.
 */
export const NJT_UPSTREAM_DAILY_TOKEN_LIMIT = 10

/** Never attempt a login more often than this for a given account. */
export const NJT_LOGIN_BACKOFF_FLOOR_MS = 5 * 60 * 1000
export const NJT_LOGIN_BACKOFF_CEILING_MS = 60 * 60 * 1000

export const NJT_LOGIN_TIMEOUT_MS = 30 * 1000
