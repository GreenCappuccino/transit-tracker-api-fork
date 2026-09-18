import { BadRequestException, Injectable } from "@nestjs/common"
import { SentryTraced } from "@sentry/nestjs"
import * as Sentry from "@sentry/node"
import ms from "ms"
import { InjectPinoLogger, PinoLogger } from "nestjs-pino"
import {
  concat,
  defer,
  distinctUntilChanged,
  exhaustMap,
  finalize,
  from,
  Observable,
  share,
  timer,
} from "rxjs"
import { DateTimeService } from "src/modules/datetime/datetime.service"
import { FeedService } from "src/modules/feed/feed.service"
import type {
  FeedProvider,
  RouteAtStop,
} from "src/modules/feed/interfaces/feed-provider.interface"
import { ScheduleMetricsService } from "./schedule-metrics.service"

export interface ScheduleTrip {
  tripId: string
  routeId: string
  routeName: string
  routeColor: string | null
  stopId: string
  stopName: string
  headsign: string
  directionId: string | null
  arrivalTime: number
  departureTime: number
  vehicle: string | null
  isRealtime: boolean
}

export interface ScheduleUpdate {
  trips: ScheduleTrip[]
}

export type RouteAtStopWithOffset = RouteAtStop & { offset: number }

export interface ScheduleOptions {
  feedCode?: string
  routes: RouteAtStopWithOffset[]
  limit: number
  sortByDeparture?: boolean
  listMode?: "sequential" | "nextPerRoute"
}

@Injectable()
export class ScheduleService {
  constructor(
    private readonly feedService: FeedService,
    private readonly metricsService: ScheduleMetricsService,
    private readonly dateTime: DateTimeService,
    @InjectPinoLogger(ScheduleService.name)
    private readonly logger: PinoLogger,
  ) {}

  @SentryTraced()
  private async getUpcomingTrips(
    provider: FeedProvider,
    { routes, limit, sortByDeparture, listMode }: ScheduleOptions,
  ): Promise<ScheduleUpdate> {
    const span = Sentry.getActiveSpan()
    if (span) {
      span.setAttribute("schedule_options.routes", JSON.stringify(routes))
      span.setAttribute("schedule_options.limit", limit)
      span.setAttribute("schedule_options.sortByDeparture", sortByDeparture)
      span.setAttribute("schedule_options.listMode", listMode)
    }

    const upcomingTrips =
      await provider.getUpcomingTripsForRoutesAtStops(routes)

    const sortKey = sortByDeparture ? "departureTime" : "arrivalTime"
    let trips: ScheduleTrip[] = upcomingTrips
      .map((trip) => {
        // Direction is part of the pair's identity: two subscriptions to the
        // same route and stop in opposite directions may carry different
        // offsets, and matching on route and stop alone would take whichever
        // came first.
        const offset = routes.find(
          (r) =>
            r.routeId === trip.routeId &&
            r.stopId === trip.stopId &&
            (r.directionId === undefined ||
              r.directionId === null ||
              r.directionId === trip.directionId),
        )?.offset

        return {
          ...trip,
          arrivalTime:
            new Date(trip.arrivalTime).getTime() / 1000 + (offset ?? 0),
          departureTime:
            new Date(trip.departureTime).getTime() / 1000 + (offset ?? 0),
        }
      })
      .filter((trip) => trip[sortKey] > this.dateTime.now().getTime() / 1000)
      .sort((a, b) => a[sortKey] - b[sortKey])

    if (listMode === "nextPerRoute") {
      const pairKey = (trip: ScheduleTrip) =>
        `${trip.routeId}-${trip.directionId}`

      const pairs = new Set<string>(trips.map((trip) => pairKey(trip)))

      trips = trips.filter((trip) => {
        const key = pairKey(trip)
        if (pairs.has(key)) {
          pairs.delete(key)
          return true
        }
        return false
      })
    }

    trips = trips.slice(0, limit)

    return {
      trips,
    }
  }

  private getFeedProvider(options: ScheduleOptions): FeedProvider {
    if (options.feedCode) {
      const provider = this.feedService.getFeedProvider(options.feedCode)
      if (!provider) {
        throw new BadRequestException("Invalid feed code")
      }

      return provider
    }

    return this.feedService.all
  }

  getSchedule(options: ScheduleOptions): Promise<ScheduleUpdate> {
    const provider = this.getFeedProvider(options)
    return this.getUpcomingTrips(provider, options)
  }

  parseRouteStopPairs(routeStopPairsRaw: string): RouteAtStopWithOffset[] {
    const routeStopPairs = routeStopPairsRaw
      .split(";")
      .map((pair) => pair.split(",").map((part) => part.trim()))
      .map(([routeIdWithDirection, stopId, offset]) => {
        // An optional `@<directionId>` suffix narrows the pair to one direction
        // of travel. Omitting it keeps the historical behaviour of returning
        // both, so existing clients are unaffected.
        //
        // `@` rather than a fourth comma-separated field, because position 3 is
        // already the offset; and rather than `:`, which route ids themselves
        // contain (global ids are `feedCode:localId`, and some providers use
        // colons within the local id too).
        const separatorIndex = routeIdWithDirection?.lastIndexOf("@") ?? -1
        const routeId =
          separatorIndex === -1
            ? routeIdWithDirection
            : routeIdWithDirection.slice(0, separatorIndex)
        const directionId =
          separatorIndex === -1
            ? undefined
            : routeIdWithDirection.slice(separatorIndex + 1)

        return {
          routeId,
          stopId,
          directionId,
          offset: parseInt(offset ?? "0"),
        }
      })

    for (const pair of routeStopPairs) {
      if (!pair.routeId || !pair.stopId) {
        throw new BadRequestException(
          "Invalid route-stop pair; must be in the format routeId[@directionId],stopId[,offset]",
        )
      }

      if (pair.directionId === "") {
        throw new BadRequestException(
          'Invalid direction; must not be empty when "@" is given',
        )
      }

      if (isNaN(pair.offset)) {
        throw new BadRequestException("Invalid offset; must be a number")
      }
    }

    return routeStopPairs
  }

  subscribeToSchedule(
    subscription: ScheduleOptions,
    isolationScope?: Sentry.Scope,
  ): Observable<ScheduleUpdate> {
    const feedProvider = this.getFeedProvider(subscription)

    return defer(() => {
      this.logger.trace({ subscription }, "Subscribed to schedule updates")

      this.metricsService.add(subscription)

      const initialDelay = Math.floor(Math.random() * 10000)
      const jitter = Math.floor(Math.random() * 5000)
      const period = ms("30s") + jitter

      // Run each poll within the connection's isolation scope so the HTTP-call
      // breadcrumbs and trace belong to that connection, not the shared scope.
      const getTrips$ = defer(() =>
        Sentry.withIsolationScope(isolationScope, () =>
          from(this.getUpcomingTrips(feedProvider, subscription)),
        ),
      )

      return concat(
        getTrips$,
        timer(initialDelay, period).pipe(exhaustMap(() => getTrips$)),
      ).pipe(
        distinctUntilChanged(this.scheduleUpdatesAreEqual.bind(this)),
        finalize(() => {
          this.logger.trace(
            { subscription },
            "Unsubscribed from schedule updates",
          )

          this.metricsService.remove(subscription)
        }),
      )
    }).pipe(share())
  }

  private scheduleUpdatesAreEqual(
    prev: ScheduleUpdate,
    curr: ScheduleUpdate,
  ): boolean {
    const pt = prev.trips
    const ct = curr.trips
    if (pt.length !== ct.length) {
      return false
    }
    for (let i = 0; i < pt.length; i++) {
      if (
        pt[i].tripId !== ct[i].tripId ||
        pt[i].arrivalTime !== ct[i].arrivalTime ||
        pt[i].departureTime !== ct[i].departureTime ||
        pt[i].isRealtime !== ct[i].isRealtime
      )
        return false
    }
    return true
  }
}
