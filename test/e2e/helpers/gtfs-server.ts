import archiver from "archiver"
import express from "express"
import { transit_realtime as GtfsRt } from "gtfs-realtime-bindings"
import { Server } from "http"
import path from "path"
import { parseMultipartFields } from "./multipart"

export async function setupFakeGtfsServer() {
  const gtfsServerApp = express()
  gtfsServerApp.use(
    express.static(path.join(__dirname, "..", "fixtures", "gtfs-static")),
  )

  let currentTripUpdates: GtfsRt.ITripUpdate[] = []
  let simulateTripUpdatesFailure = false

  let njtTokenCalls = 0
  let njtTokenLimit = Number.POSITIVE_INFINITY
  let njtToken = "NJT-TEST-TOKEN-1"

  // Mounted ahead of the header-auth middleware below, because NJ TRANSIT
  // authenticates with a field in the body rather than a header. Routing it
  // through that middleware would make these tests pass for the wrong reason.
  const njt = express.Router()
  njt.use(express.raw({ type: "multipart/form-data", limit: "5mb" }))

  const njtLogin: express.RequestHandler = (req, res) => {
    njtTokenCalls++

    if (njtTokenCalls > njtTokenLimit) {
      res
        .status(500)
        .type("application/json")
        .send(JSON.stringify({ errorMessage: "Daily usage limit exceeded." }))
      return
    }

    const fields = parseMultipartFields(
      req.body as Buffer,
      req.headers["content-type"],
    )

    if (fields.username !== "njt-user" || fields.password !== "njt-pass") {
      // What NJ TRANSIT actually answers for bad or missing credentials.
      res.status(200).type("text/plain").send("Null")
      return
    }

    res
      .status(200)
      .type("application/json")
      .send(JSON.stringify({ Authenticated: "True", UserToken: njtToken }))
  }

  njt.post("/getToken", njtLogin)
  njt.post("/authenticateUser", njtLogin)

  const njtRequireToken: express.RequestHandler = (req, res, next) => {
    const fields = parseMultipartFields(
      req.body as Buffer,
      req.headers["content-type"],
    )

    if (fields.token !== njtToken) {
      // Verified against the live API: HTTP 500 with a JSON body, not a 401.
      res
        .status(500)
        .type("application/json")
        .send(JSON.stringify({ errorMessage: "Invalid token." }))
      return
    }

    next()
  }

  njt.post("/getGTFS", njtRequireToken, (_, res) => {
    res.setHeader("Content-Type", "application/octet-stream")

    const archive = archiver("zip")
    archive.pipe(res)
    archive.directory(
      path.join(__dirname, "..", "fixtures", "feeds", "gtfs-feed"),
      "/",
    )
    archive.finalize()
  })

  njt.post("/getTripUpdates", njtRequireToken, (_, res) => {
    const message = new GtfsRt.FeedMessage({
      header: {
        gtfsRealtimeVersion: "2.0",
        incrementality: GtfsRt.FeedHeader.Incrementality.FULL_DATASET,
        timestamp: Math.floor(Date.now() / 1000),
      },
      entity: currentTripUpdates.map((tripUpdate, idx) => ({
        id: idx.toString(),
        tripUpdate,
      })),
    })

    res.setHeader("Content-Type", "application/octet-stream")
    // NJ TRANSIT sends no cache headers; no-cache here keeps the tests
    // deterministic rather than racing the realtime cache's default TTL.
    res.setHeader("Cache-Control", "no-cache")
    res.status(200).send(GtfsRt.FeedMessage.encode(message).finish())
  })

  gtfsServerApp.use("/njt", njt)

  gtfsServerApp.use((req, res, next) => {
    if (req.headers["authorization"] !== "fake-auth") {
      res.status(401).send("Unauthorized")
      return
    }

    next()
  })

  gtfsServerApp.get("/feeds/:feedName.zip", (req, res) => {
    res.setHeader("Content-Type", "application/zip")

    const archive = archiver("zip")
    archive.pipe(res)
    archive.directory(
      path.join(__dirname, "..", "fixtures", "feeds", req.params.feedName),
      "/",
    )
    archive.finalize()
  })

  gtfsServerApp.get("/gtfs-rt/trip-updates", (_, res) => {
    if (simulateTripUpdatesFailure) {
      res.status(500).send("Simulated failure")
      return
    }

    const message = new GtfsRt.FeedMessage({
      header: {
        gtfsRealtimeVersion: "1.0",
        incrementality: GtfsRt.FeedHeader.Incrementality.FULL_DATASET,
        timestamp: Math.floor(Date.now() / 1000),
      },
      entity: currentTripUpdates.map((tripUpdate, idx) => ({
        id: idx.toString(),
        tripUpdate,
      })),
    })

    res.setHeader("Content-Type", "application/x-protobuf")
    res.setHeader("Cache-Control", "no-cache")

    res.status(200).send(GtfsRt.FeedMessage.encode(message).finish())
  })

  const server = await new Promise<Server>((resolve, reject) => {
    const server = gtfsServerApp.listen(3123, (err) => {
      if (err) {
        return reject(err)
      }

      resolve(server)
    })
  })

  function setTripUpdates(updates: GtfsRt.ITripUpdate[]) {
    currentTripUpdates = updates
  }

  return {
    server,
    setTripUpdates,
    setSimulateTripUpdatesFailure: (simulate: boolean) => {
      simulateTripUpdatesFailure = simulate
    },
    getNjtTokenCallCount: () => njtTokenCalls,
    rotateNjtToken: () => {
      njtToken = `NJT-TEST-TOKEN-${njtTokenCalls + 1}-${Date.now()}`
    },
    setNjtTokenLimit: (limit: number) => {
      njtTokenLimit = limit
    },
    resetNjt: () => {
      njtTokenCalls = 0
      njtTokenLimit = Number.POSITIVE_INFINITY
      njtToken = "NJT-TEST-TOKEN-1"
    },
  }
}
