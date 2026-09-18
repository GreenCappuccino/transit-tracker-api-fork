import { Logger, Module } from "@nestjs/common"
import { Pool } from "pg"
import { env } from "src/env"
import { DateTimeModule } from "src/modules/datetime/datetime.module"
import { FeedCacheModule } from "../feed-cache/feed-cache.module"
import { PG_POOL } from "./const"
import { AUTH_STRATEGIES } from "./fetch/auth/auth-strategy.interface"
import { AuthStrategyRegistry } from "./fetch/auth/auth-strategy.registry"
import { CredentialsService } from "./fetch/credentials.service"
import { FetchService } from "./fetch/fetch.service"
import { GtfsDbService } from "./gtfs-db.service"
import { GtfsMetricsService } from "./gtfs-metrics.service"
import { GtfsRealtimeService } from "./gtfs-realtime.service"
import { GtfsService } from "./gtfs.service"
import { GtfsSyncService } from "./sync/gtfs-sync.service"
import { GtfsValidatorService } from "./sync/gtfs-validator.service"
import { WebResourceService } from "./sync/web-resource.service"
import { ZipFileService } from "./sync/zip-file.service"

@Module({
  imports: [FeedCacheModule, DateTimeModule],
  providers: [
    FetchService,
    AuthStrategyRegistry,
    CredentialsService,
    {
      // Every registered authentication strategy. New providers are added here
      // and to the zod union in ./config.ts; nothing else has to change.
      provide: AUTH_STRATEGIES,
      useFactory: () => [],
    },
    ZipFileService,
    WebResourceService,
    GtfsService,
    GtfsDbService,
    GtfsRealtimeService,
    GtfsValidatorService,
    GtfsSyncService,
    GtfsMetricsService,
    {
      provide: PG_POOL,
      useFactory: () => {
        const logger = new Logger("PgPoolFactory")

        const pool = new Pool({
          max: 2,
          connectionString: env.string("DATABASE_URL"),
        })

        pool.on("error", (err) => {
          logger.warn(
            `Unexpected error on idle client: ${err.message}\n${err.stack}`,
          )
        })

        return pool
      },
    },
  ],
  exports: [GtfsService],
})
export class GtfsModule {}
