-- migrate:up

-- Restores the column dropped by 20260331100001. It was removed as "imported but
-- never queried", which was true at the time; block-aware delay propagation
-- reads it, so it moves into the same category as stop_times.shape_dist_traveled
-- (kept by that same migration because one feature needs it).
ALTER TABLE trips ADD COLUMN IF NOT EXISTS block_id text;

-- Partial because many feeds leave block_id blank, and without feed_code because
-- queries reach a single partition where it is constant -- see
-- 20251118045713_remove-feed-code-from-indices.
CREATE INDEX IF NOT EXISTS trips_block_id_idx
  ON trips USING btree (block_id)
  WHERE block_id IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS trips_block_id_idx;
ALTER TABLE trips DROP COLUMN IF EXISTS block_id;
