BEGIN;

-- A single profile version may emit both a tier change and a review result.
-- Keep per-type deduplication in place before removing the older restriction.
CREATE UNIQUE INDEX "user_outbox_events_aggregate_id_aggregate_version_event_typ_key"
    ON "user_outbox_events"("aggregate_id", "aggregate_version", "event_type");

DROP INDEX "user_outbox_events_aggregate_id_aggregate_version_key";

COMMIT;
