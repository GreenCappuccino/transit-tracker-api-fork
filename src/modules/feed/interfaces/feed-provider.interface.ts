import { BBox } from "geojson"
import { DeepReadonly } from "ts-essentials"

export interface RouteAtStop {
  routeId: string
  stopId: string

  /**
   * Restricts results to one direction of travel. Omitted means both, which is
   * the historical behaviour.
   *
   * Providers that have no direction concept ignore this; see
   * {@link StopRoute.directions}.
   */
  directionId?: string | null
}

export interface TripStop {
  tripId: string
  stopId: string
  routeId: string
  routeName: string
  routeColor: string | null
  stopName: string
  headsign: string
  directionId: string | null
  arrivalTime: Date
  departureTime: Date
  vehicle: string | null
  isRealtime: boolean

  /**
   * Where a realtime prediction came from, or null when there is none.
   *
   * `trip` means the producer published an update for this trip. `block` means
   * it was inferred from the preceding trip on the same block, which is a
   * weaker signal -- see the `propagateBlockDelays` quirk.
   */
  predictionSource: "trip" | "block" | null
}

export interface Stop {
  stopId: string
  stopCode: string | null
  name: string
  lat: number
  lon: number
}

export interface StopRouteDirection {
  /**
   * Null when the provider has no direction concept, or when the feed omits
   * `direction_id`. A null direction cannot be selected against.
   */
  directionId: string | null
  headsigns: readonly string[]
}

export interface StopRoute {
  routeId: string
  name: string
  color: string | null

  /**
   * Every headsign served at this stop, across all directions. Kept as-is for
   * clients that predate {@link StopRoute.directions}.
   */
  headsigns: readonly string[]

  /**
   * The same headsigns split by direction of travel, so a client can offer a
   * choice between them.
   *
   * This matters most at rail-type stops, where one stop id typically serves
   * both platforms and the undirected `headsigns` list mixes inbound and
   * outbound destinations. Providers with no direction concept return a single
   * entry with a null `directionId`.
   */
  directions: readonly StopRouteDirection[]
}

export interface FeedContext<TConfig = unknown> {
  feedCode: string
  config: TConfig
}

export interface SyncOptions {
  force?: boolean
}

export interface FeedProvider {
  sync?(opts?: SyncOptions): Promise<void>
  getLastSync?(): Promise<Date | null>
  getMetadata?(): Promise<Record<string, any>>

  healthCheck(): Promise<void>

  getUpcomingTripsForRoutesAtStops(routes: RouteAtStop[]): Promise<TripStop[]>

  listStops?(): Promise<ReadonlyArray<DeepReadonly<Stop>>>

  /** @throws {StopNotFoundError} When no stop with that ID exists in the feed. */
  getStop(stopId: string): Promise<DeepReadonly<Stop>>
  getRoutesForStop(
    stopId: string,
  ): Promise<ReadonlyArray<DeepReadonly<StopRoute>>>
  getStopsInArea(bbox: BBox): Promise<ReadonlyArray<DeepReadonly<Stop>>>

  getAgencyBounds?(): Promise<DeepReadonly<BBox>>
}
