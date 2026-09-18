import ms from "ms"
import { z } from "zod"

/**
 * Credential material shared by every authentication provider.
 *
 * Each of username/password may be given inline, or as a path to a file that is
 * read when a login is performed. The file form exists for secret managers that
 * hand you a path rather than a value: systemd `LoadCredential`, Docker and
 * Compose secrets, Kubernetes projected volumes. Relative paths are resolved
 * against `$CREDENTIALS_DIRECTORY` when systemd has set it.
 */
export const CredentialFieldsSchema = z.object({
  username: z.string().min(1).optional(),
  usernameFile: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  passwordFile: z.string().min(1).optional(),
})

const DurationSchema = z.union([
  z.number().int().positive(),
  z
    .string()
    .refine((value) => typeof ms(value as ms.StringValue) === "number", {
      message: "must be a duration such as '20h' or '30m'",
    })
    .transform((value) => ms(value as ms.StringValue)),
])

export const NjTransitAuthConfigSchema = CredentialFieldsSchema.extend({
  provider: z.literal("njtransit"),

  /**
   * Which endpoint family to use. NJ TRANSIT runs rail and bus as entirely
   * separate APIs, on different hosts, with different login operations and
   * separate accounts (and therefore separate daily token budgets).
   */
  api: z.enum(["rail", "bus"]),

  /** Overrides the built-in base URL. Intended for tests and staging. */
  baseUrl: z.string().url().optional(),

  /**
   * Maximum login calls per Eastern day.
   *
   * NJ TRANSIT's own hard limit is 10 per account per day, and exceeding it
   * locks the account out of *all* endpoints until midnight Eastern. The
   * default leaves headroom for manual debugging against the same account.
   */
  dailyTokenBudget: z.number().int().min(1).max(10).default(6),

  /**
   * Re-authenticate once the cached token is older than this. NJ TRANSIT
   * documents roughly 24 hours but notes the period is subject to change, so
   * the default refreshes comfortably ahead of it.
   */
  tokenMaxAge: DurationSchema.default(ms("20h")),
}).strict()

/** Providers whose configuration includes credentials. */
const CREDENTIALED_PROVIDERS = new Set(["njtransit"])

const CREDENTIAL_PAIRS = [
  ["username", "usernameFile"],
  ["password", "passwordFile"],
] as const

/**
 * Enforces that each credential is supplied exactly once, in one form or the
 * other.
 *
 * This lives on the union rather than on individual variants because zod's
 * `discriminatedUnion` requires its options to be plain objects, and applying a
 * refinement to a variant would turn it into an effect. The rule is shared by
 * the whole family anyway.
 */
function checkCredentialPairs(
  auth: Record<string, unknown>,
  ctx: z.RefinementCtx,
) {
  if (!CREDENTIALED_PROVIDERS.has(auth.provider as string)) {
    return
  }

  for (const [inline, file] of CREDENTIAL_PAIRS) {
    const supplied = [inline, file].filter((key) => auth[key] !== undefined)
    if (supplied.length === 1) {
      continue
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [inline],
      message:
        supplied.length === 0
          ? `Exactly one of "${inline}" or "${file}" is required`
          : `"${inline}" and "${file}" are mutually exclusive; provide only one`,
    })
  }
}

/**
 * Authentication for a fetched resource.
 *
 * Discriminated on `provider` so that new providers are purely additive: a new
 * variant declares its own literal and, if it needs credentials, extends
 * {@link CredentialFieldsSchema}. Nothing outside this file and the strategy
 * registry has to change.
 */
export const AuthConfigSchema = z
  .discriminatedUnion("provider", [NjTransitAuthConfigSchema])
  .superRefine(checkCredentialPairs)

export const FetchConfigSchema = z.strictObject({
  url: z.string(),
  headers: z.record(z.string()).optional(),
  auth: AuthConfigSchema.optional(),
})

export type FetchConfig = z.infer<typeof FetchConfigSchema>

export const FetchConfigOrUrlSchema = z.union([
  FetchConfigSchema,
  // Annotated so both branches infer as FetchConfig. Without it the union
  // widens to include a branch with no `auth` key, and every consumer reading
  // `config.auth` off a `static` entry has to narrow first.
  z.string().transform((url): FetchConfig => ({ url, headers: {} })),
])

export const RouteIdFilteredFetchConfigSchema = FetchConfigSchema.extend({
  routeIds: z.array(z.string()).optional(),
})

export const GtfsConfigSchema = z.strictObject({
  quirks: z
    .object({
      fuzzyMatchTripUpdates: z.boolean().optional(),

      /**
       * Lets a trip with no realtime data of its own inherit a delay from the
       * preceding trip on the same block -- the same vehicle earlier in its
       * rotation.
       *
       * Off by default because it is inference rather than measurement: the
       * vehicle may be swapped, pulled or short-turned, and block semantics
       * vary between agencies. Predictions produced this way are reported with
       * a `predictionSource` of `block` so they stay distinguishable.
       */
      propagateBlockDelays: z.boolean().optional(),
    })
    .optional(),
  static: FetchConfigOrUrlSchema,
  rtTripUpdates: z
    .union([FetchConfigOrUrlSchema, z.array(RouteIdFilteredFetchConfigSchema)])
    .optional(),
})

export type CredentialFields = z.infer<typeof CredentialFieldsSchema>
export type NjTransitAuthConfig = z.infer<typeof NjTransitAuthConfigSchema>
export type AuthConfig = z.infer<typeof AuthConfigSchema>
export type GtfsConfig = z.infer<typeof GtfsConfigSchema>
