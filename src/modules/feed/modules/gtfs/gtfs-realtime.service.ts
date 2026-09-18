import { Inject, Injectable, Scope } from "@nestjs/common"
import { Counter } from "@opentelemetry/api"
import { parse as parseCacheControl } from "cache-control-parser"
import { transit_realtime as GtfsRt } from "gtfs-realtime-bindings"
import ms from "ms"
import { MetricService } from "nestjs-otel"
import { PinoLogger } from "nestjs-pino"
import { env } from "src/env"
import { DeepReadonly } from "ts-essentials"
import { FEED_CONTEXT } from "../../feed-context"
import type { FeedContext } from "../../interfaces/feed-provider.interface"
import { FeedCacheService } from "../feed-cache/feed-cache.service"
import type { FetchConfig, GtfsConfig } from "./config"
import { decodeTripUpdatesOnly } from "./decode-trip-updates"
import { FetchService } from "./fetch/fetch.service"
import { UpstreamHttpError } from "./gtfs.errors"
import { IGetScheduleForRouteAtStopResult } from "./queries/list-schedule-for-route.queries"

type ITripUpdate = GtfsRt.ITripUpdate
type IStopTimeUpdate = GtfsRt.TripUpdate.IStopTimeUpdate

const StopTimeScheduleRelationship =
  GtfsRt.TripUpdate.StopTimeUpdate.ScheduleRelationship

/**
 * Whether a stop time update actually says anything about when the vehicle will
 * arrive.
 *
 * GTFS-RT allows an update to reference a stop while explicitly disclaiming any
 * prediction for it — `NO_DATA` — and producers also send updates whose arrival
 * and departure objects are present but carry neither a time nor a delay. Such
 * an update tells us nothing, and treating it as realtime is worse than
 * admitting ignorance: the schedule gets presented as a live prediction.
 *
 * Note the relationship is compared against NO_DATA rather than against
 * SCHEDULED. `decodeTripUpdatesOnly` converts without protobuf defaults, so an
 * unset relationship arrives as `undefined`, not `0`.
 */
function hasPrediction(update?: DeepReadonly<IStopTimeUpdate>): boolean {
  if (!update) {
    return false
  }

  if (update.scheduleRelationship === StopTimeScheduleRelationship.NO_DATA) {
    return false
  }

  return [update.arrival, update.departure].some(
    (event) =>
      typeof event?.time === "number" || typeof event?.delay === "number",
  )
}

/**
 * How long a layover may be before the preceding trip's state stops saying
 * anything useful about the next one.
 *
 * Measured against NJ TRANSIT's bus network, layovers between consecutive trips
 * on a block are a median of 19 minutes (p25 13, p75 27), and an hour covers
 * 605 of the 632 opportunities in a sample. Past that the vehicle has enough
 * slack that its current delay tells us nothing, and claiming otherwise would
 * assert "on time" on no evidence.
 */
const MAX_BLOCK_LAYOVER_SECONDS = 60 * 60

/**
 * A skipped stop carries no prediction but must still be matched, because
 * GtfsService drops the trip on the strength of it.
 */
function isSkipped(update: DeepReadonly<IStopTimeUpdate>): boolean {
  return update.scheduleRelationship === StopTimeScheduleRelationship.SKIPPED
}

export type TripUpdateIndex = Map<
  string,
  ReadonlyArray<DeepReadonly<ITripUpdate>>
>

@Injectable({ scope: Scope.REQUEST })
export class GtfsRealtimeService {
  private readonly feedCode: string
  private readonly config: GtfsConfig
  private readonly requestsCounter: Counter
  private readonly failuresCounter: Counter
  private readonly partialDecodesCounter: Counter

  constructor(
    @Inject(FEED_CONTEXT) { feedCode, config }: FeedContext<GtfsConfig>,
    private readonly cache: FeedCacheService,
    private readonly fetchService: FetchService,
    metricService: MetricService,
    private readonly logger: PinoLogger,
  ) {
    this.feedCode = feedCode
    this.config = config
    this.logger.setContext(`${GtfsRealtimeService.name}[${feedCode}]`)

    this.requestsCounter = metricService.getCounter("gtfs_realtime_requests", {
      description: "Number of GTFS-RT fetch requests",
      unit: "requests",
    })

    this.failuresCounter = metricService.getCounter("gtfs_realtime_failures", {
      description: "Number of GTFS-RT fetch failures",
      unit: "failures",
    })

    this.partialDecodesCounter = metricService.getCounter(
      "gtfs_realtime_partial_decodes",
      {
        description:
          "Number of GTFS-RT responses that were truncated and only partially decoded",
        unit: "decodes",
      },
    )
  }

  async getTripUpdates(
    routeIds?: string[],
  ): Promise<ReadonlyArray<DeepReadonly<ITripUpdate>>> {
    if (!this.config.rtTripUpdates) {
      return []
    }

    let fetchConfigs: FetchConfig[] = []
    if (Array.isArray(this.config.rtTripUpdates)) {
      fetchConfigs = this.config.rtTripUpdates.filter((config) => {
        if (!config.routeIds || config.routeIds.length === 0) {
          return true
        }

        if (!routeIds || routeIds.length === 0) {
          return true
        }

        return config.routeIds.some((routeId) => routeIds.includes(routeId))
      })
    } else if (typeof this.config.rtTripUpdates === "object") {
      fetchConfigs = [this.config.rtTripUpdates]
    }

    if (fetchConfigs.length === 0) {
      return []
    }

    const minCacheAgeMs = env.duration("GTFS_RT_MIN_CACHE_AGE", -1)

    const responses = await Promise.allSettled(
      fetchConfigs.map((config) =>
        this.cache.cached(`tripUpdates-${config.url}`, async () => {
          this.requestsCounter.add(1, {
            feed_code: this.feedCode,
          })

          let maxAgeMs = isNaN(minCacheAgeMs) ? -1 : minCacheAgeMs

          const controller = new AbortController()
          const timeoutId = setTimeout(
            () => controller.abort("request timed out"),
            5000,
          )

          try {
            const resp = await this.fetchService.fetch(config, {
              signal: controller.signal,
              headers: {
                "User-Agent":
                  "Transit Tracker API (https://transit-tracker.eastsideurbanism.org/)",
              },
            })

            clearTimeout(timeoutId)

            if (!resp.ok) {
              throw new UpstreamHttpError(
                "GET",
                resp.url,
                resp.status,
                resp.statusText,
              )
            }

            const cacheControl = resp.headers.get("cache-control")
            if (cacheControl) {
              const directives = parseCacheControl(cacheControl)
              if (typeof directives["max-age"] === "number") {
                maxAgeMs = Math.max(maxAgeMs, directives["max-age"] * 1000)
              } else if (directives["no-cache"]) {
                maxAgeMs = Math.max(maxAgeMs, 0)
              }
            }

            const arrayBuffer = await resp.arrayBuffer()
            const { tripUpdates, truncated } = decodeTripUpdatesOnly(
              new Uint8Array(arrayBuffer),
            )

            if (truncated) {
              this.logger.warn(
                { url: config.url, entitiesRecovered: tripUpdates.length },
                "GTFS-RT response was truncated; using partially decoded trip updates",
              )
              this.partialDecodesCounter.add(1, {
                feed_code: this.feedCode,
              })
            }

            return {
              value: tripUpdates,
              ttl: maxAgeMs >= 0 ? maxAgeMs : ms("15s"),
            }
          } finally {
            clearTimeout(timeoutId)
          }
        }),
      ),
    )

    responses.forEach((response, index) => {
      if (response.status === "rejected") {
        this.logger.warn(
          { err: response.reason, url: fetchConfigs[index].url },
          "Failed to fetch trip updates",
        )

        this.failuresCounter.add(1, {
          feed_code: this.feedCode,
        })
      }
    })

    const successfulResponses = responses.filter(
      (r) => r.status === "fulfilled",
    )
    if (successfulResponses.length === 0) {
      return []
    }

    return successfulResponses.flatMap((r) => r.value)
  }

  resolveTripTimes(
    trip: DeepReadonly<IGetScheduleForRouteAtStopResult>,
    stopTimeUpdate?: DeepReadonly<IStopTimeUpdate>,
  ) {
    const scheduledArrivalTime = new Date(trip.arrival_time)
    const scheduledDepartureTime = new Date(trip.departure_time)

    let inferredDelay = 0
    if (stopTimeUpdate) {
      const definedDelay =
        stopTimeUpdate.arrival?.delay ?? stopTimeUpdate.departure?.delay

      if (typeof definedDelay === "number") {
        inferredDelay = definedDelay
      } else {
        const hasAnyUpdate = stopTimeUpdate.arrival || stopTimeUpdate.departure
        const hasOnlyOneUpdate =
          !stopTimeUpdate.arrival || !stopTimeUpdate.departure

        if (hasAnyUpdate && hasOnlyOneUpdate) {
          // Infer delay from difference between schedule and update
          for (const key of ["arrival", "departure"] as const) {
            const time = stopTimeUpdate[key]?.time
            if (typeof time !== "number") {
              continue
            }

            inferredDelay =
              time - new Date(trip[`${key}_time`]).getTime() / 1000
          }
        }
      }
    }

    const departureTime = stopTimeUpdate?.departure?.time
      ? new Date((stopTimeUpdate.departure?.time as number) * 1000)
      : new Date(
          scheduledDepartureTime.getTime() +
            (stopTimeUpdate?.departure?.delay ?? inferredDelay) * 1000,
        )

    const arrivalTime = stopTimeUpdate?.arrival?.time
      ? new Date((stopTimeUpdate.arrival?.time as number) * 1000)
      : new Date(
          scheduledArrivalTime.getTime() +
            (stopTimeUpdate?.arrival?.delay ?? inferredDelay) * 1000,
        )

    if (arrivalTime > departureTime) {
      departureTime.setTime(arrivalTime.getTime())
    }

    const maximumDeviationFromSchedule = Math.max(
      Math.abs(departureTime.getTime() - scheduledDepartureTime.getTime()),
      Math.abs(arrivalTime.getTime() - scheduledArrivalTime.getTime()),
    )

    if (maximumDeviationFromSchedule > ms("90m")) {
      // Low confidence prediction, following Transit's guidelines:
      // https://resources.transitapp.com/article/462-trip-updates#rbest
      return {
        departureTime: scheduledDepartureTime,
        arrivalTime: scheduledArrivalTime,
        isRealtime: false,
      }
    }

    return {
      departureTime,
      arrivalTime,
      // Not merely "an update existed" -- it has to have told us something.
      // Otherwise a NO_DATA stop, or one whose arrival/departure objects are
      // empty, reports the scheduled time as though it were live.
      isRealtime: hasPrediction(stopTimeUpdate),
    }
  }

  /**
   * Derives a delay for a trip that has no realtime of its own, from the trip
   * the same vehicle runs immediately before it on its block.
   *
   * The carried delay is reduced by the scheduled layover, because that is
   * recovery time: a bus twelve minutes late into a terminal with a fifteen
   * minute layover still leaves on time. A delay smaller than the layover
   * therefore yields zero, which is a real prediction rather than an absence of
   * one.
   *
   * Returns null when the predecessor has no usable delay, or when the layover
   * is long enough that its state says nothing useful about this trip.
   */
  resolveBlockDelay(
    predecessorTripId: string,
    layoverSeconds: number,
    tripUpdateIndex: TripUpdateIndex,
  ): { delay: number; vehicle: string | null } | null {
    if (layoverSeconds > MAX_BLOCK_LAYOVER_SECONDS) {
      return null
    }

    const [predecessor] = tripUpdateIndex.get(predecessorTripId) ?? []
    if (!predecessor?.stopTimeUpdate) {
      return null
    }

    // The furthest point along the predecessor we have a delay for is the best
    // estimate of how late it will finish.
    const latest = predecessor.stopTimeUpdate
      .filter(
        (update) =>
          typeof update.stopSequence === "number" &&
          (typeof update.arrival?.delay === "number" ||
            typeof update.departure?.delay === "number"),
      )
      .sort((a, b) => b.stopSequence! - a.stopSequence!)[0]

    if (!latest) {
      return null
    }

    const delay = latest.departure?.delay ?? latest.arrival?.delay
    if (typeof delay !== "number") {
      return null
    }

    return {
      delay: Math.max(0, delay - layoverSeconds),
      vehicle:
        predecessor.vehicle?.label?.trim() ||
        predecessor.vehicle?.id?.trim() ||
        null,
    }
  }

  buildTripUpdateIndex(
    tripUpdates: ReadonlyArray<DeepReadonly<ITripUpdate>>,
  ): TripUpdateIndex {
    return Map.groupBy(
      tripUpdates.filter((u) => u.trip?.tripId),
      (u) => u.trip!.tripId!,
    )
  }

  matchTripToTripUpdate(
    trip: DeepReadonly<IGetScheduleForRouteAtStopResult>,
    tripUpdateIndex: TripUpdateIndex,
  ): {
    tripUpdate: DeepReadonly<ITripUpdate> | undefined
    stopTimeUpdate: DeepReadonly<IStopTimeUpdate> | undefined
    vehicle: string | null
  } {
    // Look up candidates from the index by exact trip ID
    let tripUpdate: DeepReadonly<ITripUpdate> | undefined
    const exactCandidates = tripUpdateIndex.get(trip.trip_id)
    if (exactCandidates) {
      tripUpdate = exactCandidates.find(
        (update) =>
          update.trip.startDate === trip.start_date || !update.trip.startDate,
      )
    }

    // Fall back to fuzzy match if enabled and no exact match found
    if (!tripUpdate && this.config.quirks?.fuzzyMatchTripUpdates) {
      for (const [tripId, candidates] of tripUpdateIndex) {
        if (trip.trip_id.includes(tripId)) {
          tripUpdate = candidates.find(
            (update) =>
              update.trip.startDate === trip.start_date ||
              !update.trip.startDate,
          )
          if (tripUpdate) break
        }
      }
    }

    let stopTimeUpdate = tripUpdate?.stopTimeUpdate?.find(
      (update) =>
        (update.stopSequence === trip.stop_sequence ||
          update.stopId === trip.stop_id) &&
        // An update that predicts nothing must not shadow the fallback below.
        // Producers routinely send NO_DATA for stops they cannot predict, and
        // matching it here would discard a usable delay from an earlier stop.
        // Skipped stops are the exception: they predict nothing by nature, but
        // GtfsService needs to see them in order to drop the trip.
        (hasPrediction(update) || isSkipped(update)),
    )

    // If no exact match, find the latest stop update before our stop as fallback
    if (!stopTimeUpdate && tripUpdate?.stopTimeUpdate) {
      const previousStopUpdates = tripUpdate.stopTimeUpdate
        .filter(
          (update) =>
            typeof update.stopSequence === "number" &&
            update.stopSequence < trip.stop_sequence &&
            // Only a delay survives the synthesis below, so an earlier stop
            // that carries absolute times but no delay would synthesise an
            // empty update -- which then reads as realtime while contributing
            // nothing. Require a delay we can actually carry forward.
            (typeof update.arrival?.delay === "number" ||
              typeof update.departure?.delay === "number"),
        )
        .sort((a, b) => b.stopSequence! - a.stopSequence!)

      if (previousStopUpdates.length > 0) {
        const latestUpdate = previousStopUpdates[0]

        // Synthesize stop time update with only delay
        stopTimeUpdate = {
          departure: {
            delay: latestUpdate.departure?.delay,
          },
          arrival: {
            delay: latestUpdate.arrival?.delay,
          },
        }
      }
    }

    // Fall back to the vehicle id when no label is set. NJ TRANSIT's rail feed
    // carries the train number in `id` and leaves `label` unset, while its bus
    // feed sets `label` to an empty string -- so neither a plain `??` nor a
    // label-only read works.
    const vehicle =
      tripUpdate?.vehicle?.label?.trim() ||
      tripUpdate?.vehicle?.id?.trim() ||
      null

    return { tripUpdate, stopTimeUpdate, vehicle }
  }
}
