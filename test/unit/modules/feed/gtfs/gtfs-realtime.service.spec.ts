import { transit_realtime as GtfsRt } from "gtfs-realtime-bindings"
import type { GtfsConfig } from "src/modules/feed/modules/gtfs/config"
import { GtfsRealtimeService } from "src/modules/feed/modules/gtfs/gtfs-realtime.service"
import type { IGetScheduleForRouteAtStopResult } from "src/modules/feed/modules/gtfs/queries/list-schedule-for-route.queries"
import { beforeEach, describe, expect, it, vi } from "vitest"

const StopTimeRelationship =
  GtfsRt.TripUpdate.StopTimeUpdate.ScheduleRelationship

const SCHEDULED_ARRIVAL = new Date("2026-01-02T12:00:00Z")
const SCHEDULED_DEPARTURE = new Date("2026-01-02T12:01:00Z")

function makeTrip(
  overrides: Partial<IGetScheduleForRouteAtStopResult> = {},
): IGetScheduleForRouteAtStopResult {
  return {
    arrival_time: SCHEDULED_ARRIVAL,
    departure_time: SCHEDULED_DEPARTURE,
    direction_id: "0",
    route_color: null,
    route_id: "R1",
    route_name: "Route 1",
    start_date: "20260102",
    stop_headsign: null,
    stop_id: "S2",
    stop_name: "Second Stop",
    stop_sequence: 2,
    trip_id: "T1",
    ...overrides,
  }
}

function makeService(config: Partial<GtfsConfig> = {}) {
  return new GtfsRealtimeService(
    {
      feedCode: "testfeed",
      config: {
        static: { url: "https://example.com" },
        ...config,
      } as GtfsConfig,
    } as any,
    {} as any,
    {} as any,
    { getCounter: () => ({ add: vi.fn() }) } as any,
    { setContext: vi.fn(), warn: vi.fn() } as any,
  )
}

describe("GtfsRealtimeService", () => {
  let service: GtfsRealtimeService

  beforeEach(() => {
    service = makeService()
  })

  describe("resolveTripTimes", () => {
    it("is not realtime without any update", () => {
      const result = service.resolveTripTimes(makeTrip(), undefined)

      expect(result.isRealtime).toBe(false)
      expect(result.arrivalTime).toEqual(SCHEDULED_ARRIVAL)
    })

    // The bug this whole change exists for: an update that references the stop
    // but predicts nothing was reported as live, showing the schedule as though
    // it were a prediction.
    it("is not realtime for a NO_DATA update", () => {
      const result = service.resolveTripTimes(makeTrip(), {
        stopId: "S2",
        scheduleRelationship: StopTimeRelationship.NO_DATA,
      })

      expect(result.isRealtime).toBe(false)
      expect(result.arrivalTime).toEqual(SCHEDULED_ARRIVAL)
      expect(result.departureTime).toEqual(SCHEDULED_DEPARTURE)
    })

    it("is not realtime when arrival and departure carry nothing", () => {
      const result = service.resolveTripTimes(makeTrip(), {
        stopId: "S2",
        arrival: {},
        departure: {},
      })

      expect(result.isRealtime).toBe(false)
      expect(result.arrivalTime).toEqual(SCHEDULED_ARRIVAL)
    })

    // decodeTripUpdatesOnly converts without protobuf defaults, so an unset
    // relationship arrives as undefined rather than 0. It must still count.
    it("is realtime when the relationship is unset but timing is present", () => {
      const result = service.resolveTripTimes(makeTrip(), {
        stopId: "S2",
        arrival: { delay: 60 },
      })

      expect(result.isRealtime).toBe(true)
    })

    it("is realtime when the relationship is explicitly SCHEDULED", () => {
      const result = service.resolveTripTimes(makeTrip(), {
        stopId: "S2",
        scheduleRelationship: StopTimeRelationship.SCHEDULED,
        arrival: { delay: 60 },
      })

      expect(result.isRealtime).toBe(true)
    })

    // "On time" is a real prediction, and 0 is falsy -- an easy thing to break.
    it("treats a zero delay as a prediction", () => {
      const result = service.resolveTripTimes(makeTrip(), {
        stopId: "S2",
        arrival: { delay: 0 },
        departure: { delay: 0 },
      })

      expect(result.isRealtime).toBe(true)
      expect(result.arrivalTime).toEqual(SCHEDULED_ARRIVAL)
    })

    it("still discards predictions deviating more than 90 minutes", () => {
      const result = service.resolveTripTimes(makeTrip(), {
        stopId: "S2",
        arrival: { delay: 91 * 60 },
      })

      expect(result.isRealtime).toBe(false)
      expect(result.arrivalTime).toEqual(SCHEDULED_ARRIVAL)
    })
  })

  describe("matchTripToTripUpdate", () => {
    const index = (stopTimeUpdate: any[], extra: any = {}) =>
      service.buildTripUpdateIndex([
        { trip: { tripId: "T1" }, stopTimeUpdate, ...extra },
      ])

    it("matches an update carrying a prediction at our stop", () => {
      const { stopTimeUpdate } = service.matchTripToTripUpdate(
        makeTrip(),
        index([{ stopSequence: 2, arrival: { delay: 120 } }]),
      )

      expect(stopTimeUpdate?.arrival?.delay).toBe(120)
    })

    // The recoverable case: NO_DATA at our stop used to shadow a usable delay
    // from an earlier stop on the same trip.
    it("falls through a NO_DATA stop to an earlier stop's delay", () => {
      const { stopTimeUpdate } = service.matchTripToTripUpdate(
        makeTrip(),
        index([
          {
            stopSequence: 1,
            arrival: { delay: 300 },
            departure: { delay: 300 },
          },
          {
            stopSequence: 2,
            scheduleRelationship: StopTimeRelationship.NO_DATA,
          },
        ]),
      )

      expect(stopTimeUpdate?.arrival?.delay).toBe(300)
      expect(
        service.resolveTripTimes(makeTrip(), stopTimeUpdate).isRealtime,
      ).toBe(true)
    })

    // A skipped stop predicts nothing, but GtfsService drops the trip on the
    // strength of it, so it must still be matched here.
    it("still matches a SKIPPED update at our stop", () => {
      const { stopTimeUpdate } = service.matchTripToTripUpdate(
        makeTrip(),
        index([
          {
            stopSequence: 2,
            scheduleRelationship: StopTimeRelationship.SKIPPED,
          },
        ]),
      )

      expect(stopTimeUpdate?.scheduleRelationship).toBe(
        StopTimeRelationship.SKIPPED,
      )
    })

    // The second fake-realtime path: only `delay` survives synthesis, so an
    // earlier stop with absolute times but no delay produced an empty update
    // that nonetheless read as live.
    it("ignores an earlier stop that has absolute times but no delay", () => {
      const trip = makeTrip()
      const { stopTimeUpdate } = service.matchTripToTripUpdate(
        trip,
        index([{ stopSequence: 1, arrival: { time: 1767355200 } }]),
      )

      expect(stopTimeUpdate).toBeUndefined()
      expect(service.resolveTripTimes(trip, stopTimeUpdate).isRealtime).toBe(
        false,
      )
    })

    it("prefers the latest earlier stop that carries a delay", () => {
      const { stopTimeUpdate } = service.matchTripToTripUpdate(
        makeTrip({ stop_sequence: 5 }),
        index([
          { stopSequence: 1, arrival: { delay: 60 } },
          { stopSequence: 3, arrival: { delay: 90 } },
          { stopSequence: 4, arrival: { time: 1767355200 } },
        ]),
      )

      expect(stopTimeUpdate?.arrival?.delay).toBe(90)
    })

    describe("vehicle", () => {
      it("uses the label when present", () => {
        const { vehicle } = service.matchTripToTripUpdate(
          makeTrip(),
          index([{ stopSequence: 2, arrival: { delay: 1 } }], {
            vehicle: { id: "53967", label: "1594" },
          }),
        )

        expect(vehicle).toBe("1594")
      })

      // NJ TRANSIT's rail feed carries the train number in `id` and sets no
      // label; its bus feed sets label to an empty string.
      it("falls back to the id when the label is missing or empty", () => {
        for (const descriptor of [{ id: "0053" }, { id: "0053", label: "" }]) {
          const { vehicle } = service.matchTripToTripUpdate(
            makeTrip(),
            index([{ stopSequence: 2, arrival: { delay: 1 } }], {
              vehicle: descriptor,
            }),
          )

          expect(vehicle).toBe("0053")
        }
      })

      it("is null when neither is usable", () => {
        const { vehicle } = service.matchTripToTripUpdate(
          makeTrip(),
          index([{ stopSequence: 2, arrival: { delay: 1 } }], {
            vehicle: { id: "", label: "" },
          }),
        )

        expect(vehicle).toBeNull()
      })
    })
  })

  describe("buildTripUpdateIndex", () => {
    it("groups by trip id and drops updates without one", () => {
      const index = service.buildTripUpdateIndex([
        { trip: { tripId: "T1" } },
        { trip: { tripId: "T1", startDate: "20260102" } },
        { trip: {} },
      ])

      expect(index.get("T1")).toHaveLength(2)
      expect(index.size).toBe(1)
    })
  })
})
