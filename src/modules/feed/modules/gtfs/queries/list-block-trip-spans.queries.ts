/** Types generated for queries found in "src/modules/feed/modules/gtfs/queries/list-block-trip-spans.sql" */
import { PreparedQuery } from "@pgtyped/runtime"

export type DateOrString = Date | string

export type stringArray = string[]

/** 'ListBlockTripSpans' parameters type */
export interface IListBlockTripSpansParams {
  blockIds: stringArray
  serviceDate: DateOrString
}

/** 'ListBlockTripSpans' return type */
export interface IListBlockTripSpansResult {
  block_id: string
  ends_at: number
  starts_at: number
  trip_id: string
}

/** 'ListBlockTripSpans' query type */
export interface IListBlockTripSpansQuery {
  params: IListBlockTripSpansParams
  result: IListBlockTripSpansResult
}

const listBlockTripSpansIR: any = {
  usedParamSet: { serviceDate: true, blockIds: true },
  params: [
    {
      name: "serviceDate",
      required: true,
      transform: { type: "scalar" },
      locs: [{ a: 532, b: 544 }],
    },
    {
      name: "blockIds",
      required: true,
      transform: { type: "scalar" },
      locs: [{ a: 2051, b: 2060 }],
    },
  ],
  statement:
    '-- The scheduled span of every trip that runs on a given service date and belongs\n-- to a block, used to work out which trip a vehicle operates immediately before\n-- another one.\n--\n-- Deliberately scoped to a single service date. A block id is reused across\n-- service patterns -- the same id covers a weekday, Saturday and Sunday\n-- rotation -- so ordering a block\'s trips without that filter interleaves\n-- timetables that never run on the same day and produces layovers that look\n-- impossible.\nWITH current_day AS (\n    SELECT :serviceDate!::date AS today\n),\nactive_services AS (\n    -- Services active according to the calendar table\n    SELECT service_id\n    FROM "calendar", current_day\n    WHERE today BETWEEN start_date AND end_date\n      AND CASE\n          WHEN EXTRACT(DOW FROM today) = 0 THEN sunday\n          WHEN EXTRACT(DOW FROM today) = 1 THEN monday\n          WHEN EXTRACT(DOW FROM today) = 2 THEN tuesday\n          WHEN EXTRACT(DOW FROM today) = 3 THEN wednesday\n          WHEN EXTRACT(DOW FROM today) = 4 THEN thursday\n          WHEN EXTRACT(DOW FROM today) = 5 THEN friday\n          WHEN EXTRACT(DOW FROM today) = 6 THEN saturday\n          END = 1\n),\noverride_services AS (\n    SELECT service_id\n    FROM "calendar_dates", current_day\n    WHERE date = today\n      AND exception_type = 1\n),\nremoved_services AS (\n    SELECT service_id\n    FROM "calendar_dates", current_day\n    WHERE date = today\n      AND exception_type = 2\n),\nfinal_active_services AS (\n    SELECT DISTINCT service_id\n    FROM active_services\n    UNION\n    SELECT service_id\n    FROM override_services\n    EXCEPT\n    SELECT service_id\n    FROM removed_services\n)\nSELECT\n    t.trip_id,\n    t.block_id as "block_id!",\n    -- Seconds from the start of the service day, so these stay comparable for\n    -- trips whose stop times run past 24:00:00.\n    EXTRACT(EPOCH FROM MIN(st.departure_time))::int as "starts_at!",\n    EXTRACT(EPOCH FROM MAX(st.arrival_time))::int as "ends_at!"\nFROM "trips" t\nJOIN "stop_times" st ON st.trip_id = t.trip_id\nWHERE t.block_id = ANY(:blockIds!)\n  AND coalesce(TRIM(t.block_id), \'\') <> \'\'\n  AND t.service_id IN (SELECT service_id FROM final_active_services)\n  AND st.departure_time IS NOT NULL\n  AND st.arrival_time IS NOT NULL\nGROUP BY t.trip_id, t.block_id\nORDER BY t.block_id, MIN(st.departure_time)',
}

/**
 * Query generated from SQL:
 * ```
 * -- The scheduled span of every trip that runs on a given service date and belongs
 * -- to a block, used to work out which trip a vehicle operates immediately before
 * -- another one.
 * --
 * -- Deliberately scoped to a single service date. A block id is reused across
 * -- service patterns -- the same id covers a weekday, Saturday and Sunday
 * -- rotation -- so ordering a block's trips without that filter interleaves
 * -- timetables that never run on the same day and produces layovers that look
 * -- impossible.
 * WITH current_day AS (
 *     SELECT :serviceDate!::date AS today
 * ),
 * active_services AS (
 *     -- Services active according to the calendar table
 *     SELECT service_id
 *     FROM "calendar", current_day
 *     WHERE today BETWEEN start_date AND end_date
 *       AND CASE
 *           WHEN EXTRACT(DOW FROM today) = 0 THEN sunday
 *           WHEN EXTRACT(DOW FROM today) = 1 THEN monday
 *           WHEN EXTRACT(DOW FROM today) = 2 THEN tuesday
 *           WHEN EXTRACT(DOW FROM today) = 3 THEN wednesday
 *           WHEN EXTRACT(DOW FROM today) = 4 THEN thursday
 *           WHEN EXTRACT(DOW FROM today) = 5 THEN friday
 *           WHEN EXTRACT(DOW FROM today) = 6 THEN saturday
 *           END = 1
 * ),
 * override_services AS (
 *     SELECT service_id
 *     FROM "calendar_dates", current_day
 *     WHERE date = today
 *       AND exception_type = 1
 * ),
 * removed_services AS (
 *     SELECT service_id
 *     FROM "calendar_dates", current_day
 *     WHERE date = today
 *       AND exception_type = 2
 * ),
 * final_active_services AS (
 *     SELECT DISTINCT service_id
 *     FROM active_services
 *     UNION
 *     SELECT service_id
 *     FROM override_services
 *     EXCEPT
 *     SELECT service_id
 *     FROM removed_services
 * )
 * SELECT
 *     t.trip_id,
 *     t.block_id as "block_id!",
 *     -- Seconds from the start of the service day, so these stay comparable for
 *     -- trips whose stop times run past 24:00:00.
 *     EXTRACT(EPOCH FROM MIN(st.departure_time))::int as "starts_at!",
 *     EXTRACT(EPOCH FROM MAX(st.arrival_time))::int as "ends_at!"
 * FROM "trips" t
 * JOIN "stop_times" st ON st.trip_id = t.trip_id
 * WHERE t.block_id = ANY(:blockIds!)
 *   AND coalesce(TRIM(t.block_id), '') <> ''
 *   AND t.service_id IN (SELECT service_id FROM final_active_services)
 *   AND st.departure_time IS NOT NULL
 *   AND st.arrival_time IS NOT NULL
 * GROUP BY t.trip_id, t.block_id
 * ORDER BY t.block_id, MIN(st.departure_time)
 * ```
 */
export const listBlockTripSpans = new PreparedQuery<
  IListBlockTripSpansParams,
  IListBlockTripSpansResult
>(listBlockTripSpansIR)
