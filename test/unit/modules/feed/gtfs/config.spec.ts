import ms from "ms"
import {
  FetchConfigOrUrlSchema,
  FetchConfigSchema,
  GtfsConfigSchema,
  RouteIdFilteredFetchConfigSchema,
} from "src/modules/feed/modules/gtfs/config"
import { describe, expect, it } from "vitest"

const credentials = {
  provider: "njtransit" as const,
  api: "rail" as const,
  username: "user",
  password: "pass",
}

describe("FetchConfigSchema", () => {
  // Guards the property the rest of this feature depends on: a config without
  // `auth` must parse to exactly what it parsed to before `auth` existed.
  it("is unchanged for configs without auth", () => {
    expect(
      FetchConfigSchema.parse({ url: "https://example.com/feed.zip" }),
    ).toEqual({
      url: "https://example.com/feed.zip",
    })

    expect(
      FetchConfigSchema.parse({
        url: "https://example.com/feed.zip",
        headers: { Authorization: "token" },
      }),
    ).toEqual({
      url: "https://example.com/feed.zip",
      headers: { Authorization: "token" },
    })
  })

  it("still accepts a bare URL string", () => {
    expect(
      FetchConfigOrUrlSchema.parse("https://example.com/feed.zip"),
    ).toEqual({
      url: "https://example.com/feed.zip",
      headers: {},
    })
  })

  it("rejects unknown top-level keys", () => {
    expect(() =>
      FetchConfigSchema.parse({ url: "https://example.com", nope: true }),
    ).toThrow()
  })
})

describe("auth", () => {
  it("accepts inline credentials", () => {
    const parsed = FetchConfigSchema.parse({
      url: "https://example.com",
      auth: credentials,
    })

    expect(parsed.auth).toMatchObject({ provider: "njtransit", api: "rail" })
  })

  it("accepts file-backed credentials", () => {
    const parsed = FetchConfigSchema.parse({
      url: "https://example.com",
      auth: {
        provider: "njtransit",
        api: "bus",
        usernameFile: "njt-username",
        passwordFile: "/run/secrets/njt-password",
      },
    })

    expect(parsed.auth).toMatchObject({
      usernameFile: "njt-username",
      passwordFile: "/run/secrets/njt-password",
    })
  })

  it("allows mixing inline and file forms across different fields", () => {
    expect(() =>
      FetchConfigSchema.parse({
        url: "https://example.com",
        auth: {
          provider: "njtransit",
          api: "rail",
          username: "user",
          passwordFile: "njt-password",
        },
      }),
    ).not.toThrow()
  })

  it.each([
    ["username", "usernameFile"],
    ["password", "passwordFile"],
  ])("rejects supplying both %s and %s", (inline, file) => {
    const result = FetchConfigSchema.safeParse({
      url: "https://example.com",
      auth: { ...credentials, [file]: "some-file" },
    })

    expect(result.success).toBe(false)
    if (result.success) return

    const issue = result.error.issues.find((i) => i.path.at(-1) === inline)
    expect(issue?.message).toContain("mutually exclusive")
  })

  it.each([
    ["username", "usernameFile"],
    ["password", "passwordFile"],
  ])("rejects supplying neither %s nor %s", (inline, file) => {
    const { [inline as "username"]: _omitted, ...rest } = credentials
    const result = FetchConfigSchema.safeParse({
      url: "https://example.com",
      auth: rest,
    })

    expect(result.success).toBe(false)
    if (result.success) return

    const issue = result.error.issues.find((i) => i.path.at(-1) === inline)
    expect(issue?.message).toContain(`Exactly one of "${inline}" or "${file}"`)
  })

  it("rejects an unknown provider", () => {
    const result = FetchConfigSchema.safeParse({
      url: "https://example.com",
      auth: { ...credentials, provider: "septa" },
    })

    expect(result.success).toBe(false)
  })

  it("rejects unknown keys inside auth", () => {
    expect(() =>
      FetchConfigSchema.parse({
        url: "https://example.com",
        auth: { ...credentials, extra: true },
      }),
    ).toThrow()
  })

  it("requires a known api", () => {
    expect(() =>
      FetchConfigSchema.parse({
        url: "https://example.com",
        auth: { ...credentials, api: "ferry" },
      }),
    ).toThrow()
  })

  describe("dailyTokenBudget", () => {
    it("defaults below NJ TRANSIT's hard limit of 10", () => {
      const parsed = FetchConfigSchema.parse({
        url: "https://example.com",
        auth: credentials,
      })

      expect(parsed.auth).toMatchObject({ dailyTokenBudget: 6 })
    })

    it.each([0, 11])("rejects %i", (budget) => {
      expect(() =>
        FetchConfigSchema.parse({
          url: "https://example.com",
          auth: { ...credentials, dailyTokenBudget: budget },
        }),
      ).toThrow()
    })
  })

  describe("tokenMaxAge", () => {
    it("defaults to 20 hours", () => {
      const parsed = FetchConfigSchema.parse({
        url: "https://example.com",
        auth: credentials,
      })

      expect(parsed.auth).toMatchObject({ tokenMaxAge: ms("20h") })
    })

    it("accepts a duration string", () => {
      const parsed = FetchConfigSchema.parse({
        url: "https://example.com",
        auth: { ...credentials, tokenMaxAge: "45m" },
      })

      expect(parsed.auth).toMatchObject({ tokenMaxAge: ms("45m") })
    })

    it("rejects an unparseable duration", () => {
      expect(() =>
        FetchConfigSchema.parse({
          url: "https://example.com",
          auth: { ...credentials, tokenMaxAge: "soon" },
        }),
      ).toThrow()
    })
  })
})

describe("RouteIdFilteredFetchConfigSchema", () => {
  it("carries auth alongside routeIds", () => {
    const parsed = RouteIdFilteredFetchConfigSchema.parse({
      url: "https://example.com",
      routeIds: ["1", "2"],
      auth: credentials,
    })

    expect(parsed.routeIds).toEqual(["1", "2"])
    expect(parsed.auth).toMatchObject({ provider: "njtransit" })
  })
})

describe("GtfsConfigSchema", () => {
  it("round-trips a full NJ TRANSIT feed", () => {
    const auth = {
      provider: "njtransit",
      api: "rail",
      usernameFile: "njt-rail-username",
      passwordFile: "njt-rail-password",
    }

    const parsed = GtfsConfigSchema.parse({
      static: {
        url: "https://raildata.njtransit.com/api/GTFSRT/getGTFS",
        auth,
      },
      rtTripUpdates: {
        url: "https://raildata.njtransit.com/api/GTFSRT/getTripUpdates",
        auth,
      },
    })

    expect(parsed.static.auth).toMatchObject({ api: "rail" })
    expect(parsed.rtTripUpdates).toMatchObject({
      auth: { api: "rail" },
    })
  })
})
