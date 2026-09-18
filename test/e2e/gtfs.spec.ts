import { INestApplication } from "@nestjs/common"
import { WsAdapter } from "@nestjs/platform-ws"
import { Test } from "@nestjs/testing"
import { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { RedisContainer, StartedRedisContainer } from "@testcontainers/redis"
import fs from "fs/promises"
import { transit_realtime as GtfsRt } from "gtfs-realtime-bindings"
import ms from "ms"
import path from "path"
import { AppModule } from "src/app.module"
import { SyncCommand } from "src/commands/sync.command"
import { DateTimeService } from "src/modules/datetime/datetime.service"
import { FeedService } from "src/modules/feed/feed.service"
import { TripDto } from "src/schedule/schedule.controller"
import request from "supertest"
import { promisify } from "util"
import { vi } from "vitest"
import { setupFakeGtfsServer } from "./helpers/gtfs-server"
import { setupTestDatabase } from "./helpers/postgres"

const testTmpDir = path.join(__dirname, "tmp", `test-${Date.now()}`)

const preImportHookPath = path.join(testTmpDir, "pre-import-hook.txt")
const postImportHookPath = path.join(testTmpDir, "post-import-hook.txt")

describe("GTFS E2E test", () => {
  let postgresContainer: StartedPostgreSqlContainer
  let redisContainer: StartedRedisContainer
  let fakeGtfs: Awaited<ReturnType<typeof setupFakeGtfsServer>>
  let app: INestApplication

  const mockDateTimeNow = vi.fn()

  beforeAll(async () => {
    await fs.mkdir(testTmpDir, { recursive: true })

    const { postgresContainer: pgContainer, connectionUrl } =
      await setupTestDatabase()

    postgresContainer = pgContainer
    process.env.DATABASE_URL = connectionUrl.toString()

    redisContainer = await new RedisContainer("redis:7.2").start()
    process.env.REDIS_URL = redisContainer.getConnectionUrl()

    process.env.FEEDS_CONFIG = await fs.readFile(
      path.join(__dirname, "fixtures", "feeds.test.yaml"),
      "utf-8",
    )

    // Exercises the systemd LoadCredential path: the njtfeed config names its
    // credential files relatively, and they are resolved against this.
    process.env.CREDENTIALS_DIRECTORY = path.join(
      __dirname,
      "fixtures",
      "njt-credentials",
    )

    if (process.platform === "win32") {
      process.env.PRE_IMPORT_HOOK = `type nul > "${preImportHookPath}"`
      process.env.POST_IMPORT_HOOK = `type nul > "${postImportHookPath}"`
    } else {
      process.env.PRE_IMPORT_HOOK = `touch ${preImportHookPath}`
      process.env.POST_IMPORT_HOOK = `touch ${postImportHookPath}`
    }

    fakeGtfs = await setupFakeGtfsServer()

    process.env.DISABLE_RATE_LIMITS = "true"

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DateTimeService)
      .useValue({ now: mockDateTimeNow })
      .compile()

    app = moduleRef.createNestApplication()
    app.useWebSocketAdapter(new WsAdapter(app))
    await app.init()

    await app.get(SyncCommand).run([], {})
  }, ms("2m"))

  afterAll(async () => {
    await fs.rm(testTmpDir, { recursive: true, force: true })

    await app.close()
    await Promise.all([
      postgresContainer.stop(),
      redisContainer.stop(),
      promisify(fakeGtfs.server.close).bind(fakeGtfs.server)(),
    ])
  })

  test("import hooks were executed", async () => {
    const preImportHookExists = await fs
      .access(preImportHookPath)
      .then(() => true)
      .catch(() => false)

    const postImportHookExists = await fs
      .access(postImportHookPath)
      .then(() => true)
      .catch(() => false)

    expect(preImportHookExists).toBe(true)
    expect(postImportHookExists).toBe(true)
  })

  test("does not sync feeds with service dates in the future", async () => {
    const provider = app.get(FeedService).getFeedProvider("farfuturefeed")
    expect(provider).toBeDefined()

    const lastSync = await provider!.getLastSync?.()
    expect(lastSync).toBeNull()
  })

  test("GET /feeds", async () => {
    const response = await request(app.getHttpServer())
      .get("/feeds")
      .expect("Content-Type", /json/)
      .expect(200)

    expect(response.body).toHaveLength(5)

    const feed = response.body.find((f: any) => f.code === "testfeed")

    expect(feed.lastSyncedAt).toBeDefined()

    const now = new Date().getTime()
    const lastSyncedAt = new Date(feed.lastSyncedAt).getTime()
    expect(lastSyncedAt).toBeLessThanOrEqual(now)
    expect(lastSyncedAt).toBeGreaterThanOrEqual(now - ms("5m"))

    expect(feed.name).toBe("Test Feed")
    expect(feed.description).toBe("Test Feed Description")
    expect(feed.bounds).toEqual([-117.13316, 36.42529, -116.40094, 36.915684])
    expect(feed.metadata).toMatchSnapshot()

    const feed2 = response.body.find((f: any) => f.code === "testfeed2")

    expect(feed2.bounds).toEqual([null, null, null, null])
    expect(feed2.metadata).toMatchSnapshot()
  })

  test("GET /feeds/service-areas", async () => {
    const response = await request(app.getHttpServer())
      .get("/feeds/service-areas")
      .expect("Content-Type", /json/)
      .expect(200)

    expect(response.body).toMatchSnapshot()
  })

  test("GET /stops/within/:bbox", async () => {
    const response = await request(app.getHttpServer())
      .get("/stops/within/-116.774095,36.909629,-116.760877,36.917066")
      .expect("Content-Type", /json/)
      .expect(200)

    expect(response.body).toMatchSnapshot()
    // Two feeds serve this fixture: testfeed and njtfeed.
    expect(response.body).toHaveLength(4)
  })

  // One stop id serving both directions is the normal case for rail-type stops,
  // where the undirected headsign list mixes inbound and outbound destinations.
  test("GET /stops/:id/routes exposes directions separately", async () => {
    const response = await request(app.getHttpServer())
      .get("/stops/testfeed:AMV/routes")
      .expect(200)

    const route = response.body[0]

    // The union is preserved for clients that predate `directions`.
    expect(route.headsigns).toEqual(
      expect.arrayContaining(["to Airport", "to Amargosa Valley"]),
    )

    expect(route.directions).toEqual([
      { directionId: "0", headsigns: ["to Amargosa Valley"] },
      { directionId: "1", headsigns: ["to Airport"] },
    ])
  })

  test("GET /stops/:id/routes", async () => {
    const response = await request(app.getHttpServer())
      .get("/stops/testfeed:AMV/routes")
      .expect("Content-Type", /json/)
      .expect(200)

    expect(response.body).toHaveLength(1)
    expect(response.body).toMatchSnapshot()
  })

  describe("GET /schedule/:routeStopPairs", () => {
    beforeEach(() => {
      mockDateTimeNow.mockReturnValue(new Date("2008-01-04T13:30:00Z"))
    })

    afterEach(() => {
      mockDateTimeNow.mockReset()
    })

    async function getTripSchedule(
      scheduleString: string = "testfeed:AAMV,testfeed:BEATTY_AIRPORT;testfeed:STBA,testfeed:STAGECOACH",
    ) {
      const response = await request(app.getHttpServer())
        .get(`/schedule/${scheduleString}`)
        .expect("Content-Type", /json/)
        .expect(200)

      expect(response.body).toHaveProperty("trips")
      return response.body.trips as TripDto[]
    }

    describe("direction selection", () => {
      async function headsignsFor(pair: string) {
        const response = await request(app.getHttpServer())
          .get(`/schedule/${pair}`)
          .expect(200)

        return [
          ...new Set((response.body.trips as TripDto[]).map((t) => t.headsign)),
        ].sort()
      }

      it("returns both directions when none is given", async () => {
        await expect(
          headsignsFor("testfeed:AAMV,testfeed:BEATTY_AIRPORT"),
        ).resolves.toEqual(["to Airport", "to Amargosa Valley"])
      })

      it("returns only the requested direction", async () => {
        await expect(
          headsignsFor("testfeed:AAMV@1,testfeed:BEATTY_AIRPORT"),
        ).resolves.toEqual(["to Airport"])

        await expect(
          headsignsFor("testfeed:AAMV@0,testfeed:BEATTY_AIRPORT"),
        ).resolves.toEqual(["to Amargosa Valley"])
      })

      it("returns nothing for a direction that does not run here", async () => {
        const response = await request(app.getHttpServer())
          .get("/schedule/testfeed:AAMV@7,testfeed:BEATTY_AIRPORT")
          .expect(200)

        expect(response.body.trips).toHaveLength(0)
      })

      it("rejects an empty direction", async () => {
        await request(app.getHttpServer())
          .get("/schedule/testfeed:AAMV@,testfeed:BEATTY_AIRPORT")
          .expect(400)
      })
    })

    test("with static schedule", async () => {
      const trips = await getTripSchedule()
      expect(trips).toMatchSnapshot()
    })

    test("with service exception in static schedule", async () => {
      mockDateTimeNow.mockReturnValue(new Date("2007-06-04T13:30:00Z"))

      const trips = await getTripSchedule()
      expect(trips).toMatchSnapshot()

      // Expect trip for the 4th to be skipped
      expect(new Date(trips[0].arrivalTime * 1000).getUTCDate()).toBe(5)
    })

    test("with daylight saving time ending on service day", async () => {
      const targetSchedule = "testfeed:STBA,testfeed:STAGECOACH"

      mockDateTimeNow.mockReturnValue(new Date("2007-11-03T12:30:00Z"))

      const tripsBeforeDstEnds = await getTripSchedule(targetSchedule)

      mockDateTimeNow.mockReturnValue(new Date("2007-11-04T13:30:00Z"))

      const tripsAfterDstEnds = await getTripSchedule(targetSchedule)

      expect(tripsBeforeDstEnds[0].tripId).toBe(tripsAfterDstEnds[0].tripId)

      const arrivalBeforeDstEnds = new Date(
        tripsBeforeDstEnds[0].arrivalTime * 1000,
      )
      const arrivalAfterDstEnds = new Date(
        tripsAfterDstEnds[0].arrivalTime * 1000,
      )

      // Local time switches from GMT-7 to GMT-8, UTC time of arrival should be 1 hour later
      expect(
        arrivalAfterDstEnds.getUTCHours() - arrivalBeforeDstEnds.getUTCHours(),
      ).toBe(1)
    })

    test("with interpolated stop_times", async () => {
      const trips = await getTripSchedule("testfeed:CITY,testfeed:NADAV")

      const interpolatedTrip = trips.find((t) => t.tripId === "testfeed:CITY2")

      expect(interpolatedTrip).toBeDefined()

      const arrival = new Date(interpolatedTrip!.arrivalTime * 1000)
      expect(arrival.getUTCHours()).toBe(14)
      expect(arrival.getUTCMinutes()).toBe(42)
      expect(arrival.getUTCSeconds()).toBe(0)

      expect(interpolatedTrip!.arrivalTime).toBe(
        interpolatedTrip!.departureTime,
      )
    })

    test("with frequency-based trip", async () => {
      const trips = await getTripSchedule("testfeed:AB,testfeed:BEATTY_AIRPORT")

      // We want to skip frequency-based trips for now since they are unsupported
      expect(trips.some((trip) => trip.tripId === "testfeed:AB1")).toBe(false)
    })

    describe("with GTFS-RT updates", () => {
      afterEach(() => {
        fakeGtfs.setTripUpdates([])
        fakeGtfs.setSimulateTripUpdatesFailure(false)
      })

      test("falls back to static schedule if GTFS-RT fails", async () => {
        fakeGtfs.setSimulateTripUpdatesFailure(true)

        const trips = await getTripSchedule()
        expect(trips.length).toBeGreaterThan(0)
        expect(trips).toMatchSnapshot()
      })

      test("with same trip on multiple days", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "STBA",
              startDate: "20080104",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "STAGECOACH",
                arrival: {
                  time: 1199455200,
                },
              },
            ],
            vehicle: {
              id: "5097",
              label: "411",
            },
          },
          {
            trip: {
              tripId: "STBA",
              startDate: "20080105",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "STAGECOACH",
                arrival: {
                  time: 1199541600,
                },
              },
            ],
            vehicle: {
              id: "5277",
              label: "420",
            },
          },
        ])

        const trips = await getTripSchedule()
        const updatedTrips = trips.filter(
          (trip) => trip.tripId === "testfeed:STBA",
        )

        expect(updatedTrips).toHaveLength(2)

        expect(updatedTrips[0].arrivalTime).toBe(1199455200)
        expect(updatedTrips[0].vehicle).toBe("411")
        expect(updatedTrips[0].isRealtime).toBe(true)

        expect(updatedTrips[1].arrivalTime).toBe(1199541600)
        expect(updatedTrips[1].vehicle).toBe("420")
        expect(updatedTrips[1].isRealtime).toBe(true)
      })

      test("with same trip on multiple days using ambiguous start_date", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "STBA",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "STAGECOACH",
                arrival: {
                  time: 1199455200,
                },
              },
            ],
            vehicle: {
              id: "5097",
              label: "411",
            },
          },
        ])

        const trips = await getTripSchedule()
        const updatedTrips = trips.filter(
          (trip) => trip.tripId === "testfeed:STBA",
        )

        expect(updatedTrips).toHaveLength(2)

        expect(updatedTrips[0].arrivalTime).toBe(1199455200)
        expect(updatedTrips[0].vehicle).toBe("411")
        expect(updatedTrips[0].isRealtime).toBe(true)

        expect(updatedTrips[1].arrivalTime).toBe(1199541600)
        expect(updatedTrips[1].vehicle).toBeNull()
        expect(updatedTrips[1].isRealtime).toBe(false)
      })

      test("with cancelled trip on multiple days using ambiguous start_date", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "STBA",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.CANCELED,
            },
          },
        ])

        const trips = await getTripSchedule()
        const remainingUncancelledTrips = trips.filter(
          (trip) => trip.tripId === "testfeed:STBA",
        )

        // Expect that we have only cancelled one of the two STBA trips
        expect(remainingUncancelledTrips).toHaveLength(1)
        expect(remainingUncancelledTrips[0].arrivalTime).toBe(1199541600)
      })

      test("with skipped stop on multiple days using ambiguous start_date", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "STBA",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "STAGECOACH",
                scheduleRelationship:
                  GtfsRt.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED,
              },
            ],
          },
        ])

        const trips = await getTripSchedule()
        const remainingUncancelledTrips = trips.filter(
          (trip) => trip.tripId === "testfeed:STBA",
        )

        // Expect that we have only cancelled one of the two STBA trips
        expect(remainingUncancelledTrips).toHaveLength(1)
        expect(remainingUncancelledTrips[0].arrivalTime).toBe(1199541600)
      })

      test("with time update more than 90 minutes deviated from schedule", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "STBA",
              startDate: "20080104",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "STAGECOACH",
                arrival: {
                  time: 1199460700,
                },
              },
            ],
          },
        ])

        const trips = await getTripSchedule()
        expect(
          trips.some(
            (trip) =>
              trip.tripId === "testfeed:STBA" &&
              trip.arrivalTime === 1199460700,
          ),
        ).toBe(false)
        expect(
          trips.some(
            (trip) => trip.tripId === "testfeed:STBA" && trip.isRealtime,
          ),
        ).toBe(false)
      })

      test.each(["arrival", "departure"])(
        "with %s time update",
        async (arrivalOrDeparture: string) => {
          fakeGtfs.setTripUpdates([
            {
              trip: {
                tripId: "STBA",
                startDate: "20080104",
                scheduleRelationship:
                  GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
              },
              stopTimeUpdate: [
                {
                  stopId: "STAGECOACH",
                  [arrivalOrDeparture]: {
                    time: 1199455230,
                  },
                },
              ],
              vehicle: {
                id: "5097",
                label: "411",
              },
            },
          ])

          const trips = await getTripSchedule()
          const trip = trips.find((trip) => trip.tripId === "testfeed:STBA")

          expect(trip).toBeDefined()
          expect(trip!.arrivalTime).toBe(1199455230)
          expect(trip!.departureTime).toBe(1199455230)
          expect(trip!.vehicle).toBe("411")
          expect(trip!.isRealtime).toBe(true)
        },
      )

      test("with different arrival and departure time updates", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "STBA",
              startDate: "20080104",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "STAGECOACH",
                arrival: {
                  time: 1199455230,
                },
                departure: {
                  time: 1199455260,
                },
              },
            ],
            vehicle: {
              id: "5097",
              label: "411",
            },
          },
        ])

        const trips = await getTripSchedule()
        const trip = trips.find((trip) => trip.tripId === "testfeed:STBA")

        expect(trip).toBeDefined()
        expect(trip!.arrivalTime).toBe(1199455230)
        expect(trip!.departureTime).toBe(1199455260)
        expect(trip!.vehicle).toBe("411")
        expect(trip!.isRealtime).toBe(true)
      })

      test.each(["arrival", "departure"])(
        "with %s delay",
        async (arrivalOrDeparture: string) => {
          fakeGtfs.setTripUpdates([
            {
              trip: {
                tripId: "STBA",
                startDate: "20080104",
                scheduleRelationship:
                  GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
              },
              stopTimeUpdate: [
                {
                  stopId: "STAGECOACH",
                  [arrivalOrDeparture]: {
                    delay: 30,
                  },
                },
              ],
              vehicle: {
                id: "5097",
                label: "411",
              },
            },
          ])

          const trips = await getTripSchedule()
          const trip = trips.find((trip) => trip.tripId === "testfeed:STBA")

          expect(trip).toBeDefined()
          expect(trip!.arrivalTime).toBe(1199455230)
          expect(trip!.departureTime).toBe(1199455230)
          expect(trip!.vehicle).toBe("411")
          expect(trip!.isRealtime).toBe(true)
        },
      )

      test("with different arrival and departure delays", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "STBA",
              startDate: "20080104",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "STAGECOACH",
                arrival: {
                  delay: 30,
                },
                departure: {
                  delay: 60,
                },
              },
            ],
            vehicle: {
              id: "5097",
              label: "411",
            },
          },
        ])

        const trips = await getTripSchedule()
        const trip = trips.find((trip) => trip.tripId === "testfeed:STBA")

        expect(trip).toBeDefined()
        expect(trip!.arrivalTime).toBe(1199455230) // + 30
        expect(trip!.departureTime).toBe(1199455260) // + 60
        expect(trip!.vehicle).toBe("411")
        expect(trip!.isRealtime).toBe(true)
      })

      test("with cancelled trip", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "AAMV1",
              startDate: "20080105",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.CANCELED,
            },
          },
        ])

        const trips = await getTripSchedule()
        expect(trips.some((trip) => trip.tripId === "testfeed:AAMV1")).toBe(
          false,
        )
      })

      // An overnight trip's GTFS service date is the day it *started*, not the
      // calendar date its post-midnight stop falls on. A producer sending the
      // spec-correct start_date previously failed to match, because the service
      // derived one by adding the stop time to the service day.
      test("matches an overnight trip by its service date", async () => {
        mockDateTimeNow.mockReturnValue(new Date("2008-01-05T08:25:00.000Z"))

        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "STBA_OVERNIGHT",
              // The service day it departed on, though it arrives on the 5th.
              startDate: "20080104",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              { stopId: "STAGECOACH", arrival: { time: 1199521830 } },
            ],
          },
        ])

        const trips = await getTripSchedule()
        const overnightTrips = trips.filter(
          (trip) => trip.tripId === "testfeed:STBA_OVERNIGHT",
        )

        expect(overnightTrips.length).toBeGreaterThan(0)
        expect(overnightTrips[0].arrivalTime).toBe(1199521830)
        expect(overnightTrips[0].isRealtime).toBe(true)
      })

      test("with update to overnight trip (crossing midnight)", async () => {
        mockDateTimeNow.mockReturnValue(new Date("2008-01-05T08:25:00.000Z"))

        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "STBA_OVERNIGHT",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "STAGECOACH",
                arrival: {
                  time: 1199521830,
                },
              },
            ],
          },
        ])

        const trips = await getTripSchedule()
        const overnightTrips = trips.filter(
          (trip) => trip.tripId === "testfeed:STBA_OVERNIGHT",
        )

        expect(overnightTrips).toHaveLength(2)

        expect(overnightTrips[0].arrivalTime).toBe(1199521830)
        expect(overnightTrips[0].departureTime).toBe(1199521830)
        expect(overnightTrips[0].isRealtime).toBe(true)

        expect(overnightTrips[1].arrivalTime).toBe(1199608200)
        expect(overnightTrips[1].departureTime).toBe(1199608200)
        expect(overnightTrips[1].isRealtime).toBe(false)
      })

      test("with skipped stop by stop_id", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "AAMV2",
              startDate: "20080105",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "BEATTY_AIRPORT",
                scheduleRelationship:
                  GtfsRt.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED,
              },
            ],
          },
          {
            trip: {
              tripId: "AAMV3",
              startDate: "20080105",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "SOME_OTHER_STOP",
                scheduleRelationship:
                  GtfsRt.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED,
              },
            ],
          },
        ])

        const trips = await getTripSchedule()
        expect(trips.some((trip) => trip.tripId === "testfeed:AAMV2")).toBe(
          false,
        )

        expect(trips.some((trip) => trip.tripId === "testfeed:AAMV3")).toBe(
          true,
        )
      })

      test("with skipped stop by stop_sequence", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "AAMV2",
              startDate: "20080105",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopSequence: 2, // stop_id: BEATTY_AIRPORT
                scheduleRelationship:
                  GtfsRt.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED,
              },
            ],
          },
          {
            trip: {
              tripId: "AAMV3",
              startDate: "20080105",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopSequence: 2, // stop_id: AMV
                scheduleRelationship:
                  GtfsRt.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED,
              },
            ],
          },
        ])

        const trips = await getTripSchedule()
        expect(trips.some((trip) => trip.tripId === "testfeed:AAMV2")).toBe(
          false,
        )

        expect(trips.some((trip) => trip.tripId === "testfeed:AAMV3")).toBe(
          true,
        )
      })

      // Tests for fallback delay from previous stop updates
      test("with fallback delay from previous stop", async () => {
        const delaySeconds = 120
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "CITY1",
              startDate: "20080104",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopSequence: 0,
                arrival: {
                  delay: delaySeconds,
                },
              },
              // No update for stopSequence: 2, should use fallback
            ],
            vehicle: {
              id: "53967",
              label: "1594",
            },
          },
        ])

        const trips = await getTripSchedule("testfeed:CITY,testfeed:NADAV")
        const trip = trips.find((trip) => trip.tripId === "testfeed:CITY1")
        expect(trip).toBeDefined()

        // Should use the 120s delay from previous stop
        const scheduledTimeArrivalTime = 1199455920
        const scheduledDepartureTime = 1199456040
        expect(trip!.arrivalTime).toBe(scheduledTimeArrivalTime + delaySeconds)
        expect(trip!.departureTime).toBe(scheduledDepartureTime + delaySeconds)
        expect(trip!.vehicle).toBe("1594")
        expect(trip!.isRealtime).toBe(true)
      })

      // A NO_DATA stop predicts nothing. Reporting it as realtime showed the
      // scheduled time wearing a live badge.
      test("is not realtime for a NO_DATA stop", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "CITY1",
              startDate: "20080104",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopSequence: 2,
                scheduleRelationship:
                  GtfsRt.TripUpdate.StopTimeUpdate.ScheduleRelationship.NO_DATA,
              },
            ],
            vehicle: { id: "53967", label: "1594" },
          },
        ])

        const trips = await getTripSchedule("testfeed:CITY,testfeed:NADAV")
        const trip = trips.find((trip) => trip.tripId === "testfeed:CITY1")
        expect(trip).toBeDefined()

        expect(trip!.arrivalTime).toBe(1199455920)
        expect(trip!.departureTime).toBe(1199456040)
        expect(trip!.isRealtime).toBe(false)
        expect(trip!.vehicle).toBeNull()
      })

      // NO_DATA at our stop used to shadow a usable delay from an earlier one.
      test("falls through a NO_DATA stop to an earlier stop's delay", async () => {
        const delaySeconds = 120
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "CITY1",
              startDate: "20080104",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              { stopSequence: 0, arrival: { delay: delaySeconds } },
              {
                stopSequence: 2,
                scheduleRelationship:
                  GtfsRt.TripUpdate.StopTimeUpdate.ScheduleRelationship.NO_DATA,
              },
            ],
            vehicle: { id: "53967", label: "1594" },
          },
        ])

        const trips = await getTripSchedule("testfeed:CITY,testfeed:NADAV")
        const trip = trips.find((trip) => trip.tripId === "testfeed:CITY1")
        expect(trip).toBeDefined()

        expect(trip!.arrivalTime).toBe(1199455920 + delaySeconds)
        expect(trip!.departureTime).toBe(1199456040 + delaySeconds)
        expect(trip!.isRealtime).toBe(true)
        expect(trip!.vehicle).toBe("1594")
      })

      // Only a delay survives the fallback synthesis, so an earlier stop with
      // absolute times but no delay contributed nothing while still reading as
      // realtime.
      test("is not realtime when the only earlier stop has no delay", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "CITY1",
              startDate: "20080104",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              { stopSequence: 0, arrival: { time: 1199455800 } },
            ],
            vehicle: { id: "53967", label: "1594" },
          },
        ])

        const trips = await getTripSchedule("testfeed:CITY,testfeed:NADAV")
        const trip = trips.find((trip) => trip.tripId === "testfeed:CITY1")
        expect(trip).toBeDefined()

        expect(trip!.arrivalTime).toBe(1199455920)
        expect(trip!.isRealtime).toBe(false)
        expect(trip!.vehicle).toBeNull()
      })

      test("uses the vehicle id when no label is set", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "CITY1",
              startDate: "20080104",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [{ stopSequence: 2, arrival: { delay: 60 } }],
            vehicle: { id: "0053" },
          },
        ])

        const trips = await getTripSchedule("testfeed:CITY,testfeed:NADAV")
        const trip = trips.find((trip) => trip.tripId === "testfeed:CITY1")
        expect(trip).toBeDefined()

        expect(trip!.isRealtime).toBe(true)
        expect(trip!.vehicle).toBe("0053")
      })

      test("with fallback delay when multiple previous stops exist", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "CITY1",
              startDate: "20080104",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopSequence: 1,
                arrival: {
                  delay: 60,
                },
              },
              {
                stopSequence: 2,
                arrival: {
                  delay: 90, // More recent delay
                },
              },
            ],
            vehicle: {
              id: "53967",
              label: "1594",
            },
          },
        ])

        const trips = await getTripSchedule("testfeed:CITY,testfeed:NADAV")
        const trip = trips.find((trip) => trip.tripId === "testfeed:CITY1")
        expect(trip).toBeDefined()

        // Should use the 90s delay from stop sequence 2
        const scheduledTimeArrivalTime = 1199455920
        const scheduledDepartureTime = 1199456040
        expect(trip!.arrivalTime).toBe(scheduledTimeArrivalTime + 90)
        expect(trip!.departureTime).toBe(scheduledDepartureTime + 90)
        expect(trip!.vehicle).toBe("1594")
        expect(trip!.isRealtime).toBe(true)
      })

      test("without fallback when no previous stop updates exist", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "CITY1",
              startDate: "20080104",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopSequence: 4, // Update for a LATER stop (DADAN)
                arrival: {
                  delay: 120,
                },
              },
            ],
            vehicle: {
              id: "53967",
              label: "1594",
            },
          },
        ])

        const trips = await getTripSchedule("testfeed:CITY,testfeed:NADAV")
        const trip = trips.find((trip) => trip.tripId === "testfeed:CITY1")
        expect(trip).toBeDefined()

        // Should use scheduled time (1199455920) because update is for a later stop
        expect(trip!.arrivalTime).toBe(1199455920)
        expect(trip!.vehicle).toBeNull()
        expect(trip!.isRealtime).toBe(false)
      })

      test("with fallback delay respects 90m deviation limit", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "CITY1",
              startDate: "20080104",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopSequence: 1, // Update for an EARLIER stop (STAGECOACH)
                arrival: {
                  delay: 6000, // 100 minutes delay - exceeds 90m limit
                },
              },
            ],
            vehicle: {
              id: "53967",
              label: "1594",
            },
          },
        ])

        const trips = await getTripSchedule("testfeed:CITY,testfeed:NADAV")
        const trip = trips.find((trip) => trip.tripId === "testfeed:CITY1")
        expect(trip).toBeDefined()

        // Should fall back to scheduled time due to excessive deviation (> 90m)
        expect(trip!.arrivalTime).toBe(1199455920)
        expect(trip!.vehicle).toBeNull()
        expect(trip!.isRealtime).toBe(false)
      })
    })
  })

  // These run last on purpose: the final test drives a login failure, which
  // arms a multi-minute backoff on the shared NJ TRANSIT account.
  describe("NJ TRANSIT authenticated feed", () => {
    beforeEach(() => {
      mockDateTimeNow.mockReturnValue(new Date("2008-01-04T13:30:00Z"))
    })

    afterEach(() => {
      mockDateTimeNow.mockReset()
      fakeGtfs.setTripUpdates([])
    })

    async function getNjtSchedule() {
      const response = await request(app.getHttpServer())
        .get("/schedule/njtfeed:STBA,njtfeed:STAGECOACH")
        .expect("Content-Type", /json/)
        .expect(200)

      return response.body.trips as TripDto[]
    }

    // The headline assertion: a whole import plus realtime traffic costs one
    // login, not one per request.
    test("authenticates once for the import and all realtime requests", async () => {
      await getNjtSchedule()
      await getNjtSchedule()
      await getNjtSchedule()

      expect(fakeGtfs.getNjtTokenCallCount()).toBe(1)
    })

    test("imported the feed through the authenticated API", async () => {
      const response = await request(app.getHttpServer())
        .get("/feeds")
        .expect(200)

      const njt = response.body.find((feed: any) => feed.code === "njtfeed")
      expect(njt).toBeDefined()
      expect(njt.lastSyncedAt).not.toBeNull()
    })

    test("applies realtime updates fetched with a token", async () => {
      fakeGtfs.setTripUpdates([
        {
          trip: {
            tripId: "STBA",
            startDate: "20080104",
            scheduleRelationship:
              GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
          },
          stopTimeUpdate: [
            {
              stopId: "STAGECOACH",
              arrival: { time: 1199455200 },
            },
          ],
          vehicle: { id: "5097", label: "411" },
        },
      ])

      const trips = await getNjtSchedule()
      const trip = trips.find((t) => t.tripId === "njtfeed:STBA")

      expect(trip).toBeDefined()
      expect(trip!.isRealtime).toBe(true)
      expect(trip!.arrivalTime).toBe(1199455200)
    })

    test("re-authenticates exactly once when the token is rejected", async () => {
      const before = fakeGtfs.getNjtTokenCallCount()
      fakeGtfs.rotateNjtToken()

      await getNjtSchedule()

      expect(fakeGtfs.getNjtTokenCallCount()).toBe(before + 1)
    })

    test("degrades to the static schedule when logins are refused", async () => {
      fakeGtfs.setNjtTokenLimit(0)
      fakeGtfs.rotateNjtToken()

      const trips = await getNjtSchedule()

      // Realtime is lost, but the schedule still renders: GtfsRealtimeService
      // settles each fetch independently and falls back to static data.
      expect(trips.length).toBeGreaterThan(0)
      expect(trips.every((trip) => trip.isRealtime === false)).toBe(true)
    })
  })
})
