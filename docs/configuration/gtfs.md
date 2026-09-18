# GTFS Configuration

The Transit Tracker API supports [static GTFS feeds](https://gtfs.org/documentation/schedule/reference/) with one or more optional [GTFS-realtime Trip Updates](https://gtfs.org/documentation/realtime/feed-entities/trip-updates/) feeds to supplement the static schedule with real-time updates.

To add a GTFS feed, add a feed to your `feeds.yaml` with a `gtfs:` section. Here is a basic example:

```yaml
feeds:
  nctd:
    name: North County Transit District
    description: San Diego, California
    gtfs:
      static: https://lfportal.nctd.org/staticGTFS/google_transit.zip
      # If your transit agency doesn't support GTFS-rt, you can omit this section
      rtTripUpdates:
        url: https://api.goswift.ly/real-time/nctd/gtfs-rt-trip-updates
        headers:
          Authorization: your_swiftly_api_key
```

You can find a full reference in the [YAML schema](../../schemas/feeds.schema.json).

## Static GTFS

### Feed Sync

It's important to keep GTFS data up-to-date as agencies make service changes. You can set up automatic synchronization of feeds by defining a `FEED_SYNC_SCHEDULE` environment variable using a [cron expression](https://en.wikipedia.org/wiki/Cron). For example, to sync all feeds once every day, set the following environment variable:

```shell
FEED_SYNC_SCHEDULE="0 0 * * *"
```

You can also manually sync feeds at any time using the CLI. If you are using the [Docker Compose deployment](../deployment/deploy-docker.md), you can run the following command:

```shell
docker compose run --rm api "node ./dist/cli sync"
```

Static feeds will not be imported unless they have changed since last import. This is determined using the `Last-Modified` or `ETag` HTTP headers, or if neither are provided by the server, a hash of the ZIP file. You can force a re-import of all feeds by adding the `--force`/`-f` flag.

Feeds behind an [authenticated API](#authenticated-feeds) whose transport cannot answer a metadata request are handled differently: there is nothing to send a `HEAD` to, so the archive is downloaded on every sync and hashed afterwards. The feed is still only *imported* when that hash changes, which is the expensive part.

> Note that this compares the archive's bytes, not the data inside it. An agency that regenerates its ZIP per request — NJ TRANSIT's rail feed does, producing a different archive each time from identical data — will re-import on every sync regardless. That is cheap for a small feed and wasteful for a large one, so prefer an infrequent `--feed` sync for those.

```shell
docker compose run --rm api "node ./dist/cli sync -f"
```

You can also sync a specific feed by providing its feed code using the `--feed` flag. Provide multiple times to sync multiple feeds.

```shell
docker compose run --rm api "node ./dist/cli sync --feed nctd --feed septabus"
```

### ZIP-in-ZIP Feeds

Some agencies will publish their GTFS feeds as a ZIP file that contains another ZIP file inside of it. In this case, you can specify the path of the inner ZIP file in the URL hash. During import, the API will first extract the outer ZIP file, then extract the inner ZIP file for processing.

For example, SEPTA publishes both of their GTFS feeds as a single ZIP file which contains two ZIP files inside of it: one for bus (`google_bus.zip`) and one for rail (`google_rail.zip`). You can configure both feeds like this:

```yaml
feeds:
  septarail:
    name: SEPTA Rail
    description: Philadelphia, Pennsylvania, USA
    gtfs:
      static:
        url: https://github.com/septadev/GTFS/releases/latest/download/gtfs_public.zip#google_rail.zip
  septabus:
    name: SEPTA Bus
    description: Philadelphia, Pennsylvania, USA
    gtfs:
      static:
        url: https://github.com/septadev/GTFS/releases/latest/download/gtfs_public.zip#google_bus.zip
```

## GTFS-Realtime Trip Updates

### GTFS-RT Caching

The API will respect the [`Cache-Control` header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control) when determining how long to cache a GTFS-RT feed before fetching it again.

You can control the minimum cache duration for GTFS-RT feeds by specifying a `GTFS_RT_MIN_CACHE_AGE` environment variable. For example, to set the minimum cache duration to 30 seconds, set the following environment variable:

```shell
GTFS_RT_MIN_CACHE_AGE=30s
```

If there is no `Cache-Control` header or `GTFS_RT_MIN_CACHE_AGE` is not set, the API will default to caching GTFS-RT feeds for 15 seconds.

### Multiple GTFS-RT Feeds

Some agencies will publish updates through multiple GTFS-RT feeds, e.g. one for bus routes and another for rail routes. You can configure multiple GTFS-RT feeds by providing a list instead of a single object. The API will fetch all feeds and merge the trip updates together.

For example, Pittsburgh Regional Transit provides separate feeds for bus and rail updates:

```yaml
feeds:
  prt:
    name: Pittsburgh Regional Transit
    description: Pittsburgh, Pennsylvania, USA
    gtfs:
      static:
        url: https://www.rideprt.org/developerresources/GTFS.zip
      rtTripUpdates:
        - url: https://truetime.rideprt.org/gtfsrt-bus/trips
        - url: https://truetime.rideprt.org/gtfsrt-train/trips
```

#### Filtering by Route

Some agencies will split their GTFS-RT feeds by route ID. If you know the route IDs for each feed ahead of time, you can configure the API to only request updates for those routes by specifying a `routeIds` array for each feed. This will improve performance by only requesting the necessary GTFS-RT feeds for a given request.

For example, the NYC subway's GTFS-RT Trip Updates are split across multiple feeds by route ID:

```yaml
feeds:
  nycsubway:
    name: NYC Subway
    description: New York City, New York, USA
    gtfs:
      quirks:
        fuzzyMatchTripUpdates: true
      static:
        url: https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip
      rtTripUpdates:
        - url: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace
          routeIds: ["A","C","E","H"]
        - url: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm
          routeIds: ["B","D","F","FX","M","FS"]
        - url: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g
          routeIds: ["G"]
        - url: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz
          routeIds: ["J","Z"]
        - url: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw
          routeIds: ["N","Q","R","W"]
        - url: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l
          routeIds: ["L"]
        - url: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs
          routeIds: ["1","2","3","4","5","6","6X","7","7X","GS"]
        - url: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si
          routeIds: ["SI"]
```

## Authenticated Feeds

Some agencies put their GTFS behind a login rather than a plain URL. Any `static` or `rtTripUpdates` entry can carry an `auth` block describing how to authenticate, discriminated on `provider`:

```yaml
gtfs:
  static:
    url: https://example.com/getGTFS
    auth:
      provider: someprovider
      # provider-specific fields
```

This is separate from `headers`, which remains the right tool when a feed only needs a static API key or bearer token.

### NJ TRANSIT

NJ TRANSIT's GTFS and GTFS-RT are served by an API that requires a session token. Register for credentials at [the NJ TRANSIT developer portal](https://developer.njtransit.com/registration); rail and bus are **separate APIs with separate accounts**, so a deployment carrying both needs two sets of credentials.

```yaml
feeds:
  njtrail:
    name: NJ TRANSIT Rail
    description: New Jersey, USA
    gtfs:
      static:
        url: https://raildata.njtransit.com/api/GTFSRT/getGTFS
        auth: &njtrail
          provider: njtransit
          api: rail
          username: YOUR_USERNAME
          password: YOUR_PASSWORD
      rtTripUpdates:
        url: https://raildata.njtransit.com/api/GTFSRT/getTripUpdates
        auth: *njtrail

  njtbus:
    name: NJ TRANSIT Bus
    description: New Jersey, USA
    gtfs:
      static:
        url: https://pcsdata.njtransit.com/api/GTFSG2/getGTFS
        auth: &njtbus
          provider: njtransit
          api: bus
          username: YOUR_USERNAME
          password: YOUR_PASSWORD
      rtTripUpdates:
        url: https://pcsdata.njtransit.com/api/GTFSG2/getTripUpdates
        auth: *njtbus
```

The YAML anchor (`&njtrail` / `*njtrail`) is the intended way to avoid repeating credentials across the static and realtime entries.

> **The static feed must come from this API too.** The `trip_id`s in NJ TRANSIT's public ZIP downloads have **no overlap** with the ones in its realtime feed, so pairing `rtTripUpdates` with a public ZIP matches nothing and every trip silently reports `isRealtime: false`. See [the feed library](./feed-library.md#nj-transit-rail).

#### The daily login limit

NJ TRANSIT permits **10 logins per account per day**, resetting at midnight Eastern. Exceeding it locks the account out of *every* endpoint for the rest of the day, so this is treated as a hard constraint rather than a rate limit:

- The token is cached in Redis, shared across instances and preserved across restarts. In steady state a deployment spends **one login per account per day**.
- `dailyTokenBudget` (default `6`) caps logins below NJ TRANSIT's own limit, leaving headroom for debugging against the same account. Once reached, the feed reports an upstream error instead of logging in again. Realtime degrades to the static schedule; it does not take the feed down.
- `tokenMaxAge` (default `20h`) controls proactive re-authentication.

Setting `REDIS_URL` is what makes the budget hold across restarts and instances. Without it the count is per-process only, and a restart loop can exhaust the account.

#### Credentials from files

Both `username` and `password` accept a `File` variant naming a path read at login time, which keeps secrets out of the config:

```yaml
auth:
  provider: njtransit
  api: rail
  usernameFile: njt-rail-username
  passwordFile: njt-rail-password
```

Relative paths resolve against `$CREDENTIALS_DIRECTORY`, so they pair directly with systemd credentials:

```ini
[Service]
LoadCredential=njt-rail-username:/etc/transit-tracker/njt-rail-username
LoadCredential=njt-rail-password:/etc/transit-tracker/njt-rail-password
```

Absolute paths are used as-is, which is what you want for Docker or Compose secrets:

```yaml
auth:
  provider: njtransit
  api: bus
  usernameFile: /run/secrets/njt_bus_username
  passwordFile: /run/secrets/njt_bus_password
```

Files are read fresh on each login, so rotating a secret takes effect without a restart. Trailing whitespace is stripped.

## Quirks

Even though GTFS is a standard, some agencies will have slight variations in their data that require special handling. You can enable certain "quirks" to account for these variations. Quirks are configured in the `gtfs.quirks` section of your feed configuration.

### `fuzzyMatchTripUpdates`

By default, the API will only apply GTFS-RT Trip Updates to trips that exactly match a trip ID in the static GTFS feed. However, some agencies (like NYC MTA) will use different trip IDs in their GTFS-RT feeds that don't exactly match the static feed. This is usually due to operational reasons.

If `fuzzyMatchTripUpdates` is enabled, the API will instead match Trip Updates based on a partial match of the trip ID. For example, if a Trip Update has a trip ID of `12345`, it will match a static GTFS trip with an ID of `12345-ABCD`.