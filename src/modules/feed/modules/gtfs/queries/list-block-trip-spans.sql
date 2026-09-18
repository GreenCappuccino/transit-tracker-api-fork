/* @name ListBlockTripSpans */
-- The scheduled span of every trip that runs on a given service date and belongs
-- to a block, used to work out which trip a vehicle operates immediately before
-- another one.
--
-- Deliberately scoped to a single service date. A block id is reused across
-- service patterns -- the same id covers a weekday, Saturday and Sunday
-- rotation -- so ordering a block's trips without that filter interleaves
-- timetables that never run on the same day and produces layovers that look
-- impossible.
WITH current_day AS (
    SELECT :serviceDate!::date AS today
),
active_services AS (
    -- Services active according to the calendar table
    SELECT service_id
    FROM "calendar", current_day
    WHERE today BETWEEN start_date AND end_date
      AND CASE
          WHEN EXTRACT(DOW FROM today) = 0 THEN sunday
          WHEN EXTRACT(DOW FROM today) = 1 THEN monday
          WHEN EXTRACT(DOW FROM today) = 2 THEN tuesday
          WHEN EXTRACT(DOW FROM today) = 3 THEN wednesday
          WHEN EXTRACT(DOW FROM today) = 4 THEN thursday
          WHEN EXTRACT(DOW FROM today) = 5 THEN friday
          WHEN EXTRACT(DOW FROM today) = 6 THEN saturday
          END = 1
),
override_services AS (
    SELECT service_id
    FROM "calendar_dates", current_day
    WHERE date = today
      AND exception_type = 1
),
removed_services AS (
    SELECT service_id
    FROM "calendar_dates", current_day
    WHERE date = today
      AND exception_type = 2
),
final_active_services AS (
    SELECT DISTINCT service_id
    FROM active_services
    UNION
    SELECT service_id
    FROM override_services
    EXCEPT
    SELECT service_id
    FROM removed_services
)
SELECT
    t.trip_id,
    t.block_id as "block_id!",
    -- Seconds from the start of the service day, so these stay comparable for
    -- trips whose stop times run past 24:00:00.
    EXTRACT(EPOCH FROM MIN(st.departure_time))::int as "starts_at!",
    EXTRACT(EPOCH FROM MAX(st.arrival_time))::int as "ends_at!"
FROM "trips" t
JOIN "stop_times" st ON st.trip_id = t.trip_id
WHERE t.block_id = ANY(:blockIds!)
  AND coalesce(TRIM(t.block_id), '') <> ''
  AND t.service_id IN (SELECT service_id FROM final_active_services)
  AND st.departure_time IS NOT NULL
  AND st.arrival_time IS NOT NULL
GROUP BY t.trip_id, t.block_id
ORDER BY t.block_id, MIN(st.departure_time);
