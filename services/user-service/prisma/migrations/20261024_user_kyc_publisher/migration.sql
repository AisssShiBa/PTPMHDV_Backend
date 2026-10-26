ALTER TABLE users ADD COLUMN kyc_back_object_key TEXT;

ALTER TABLE user_outbox_events
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN locked_until TIMESTAMP(3),
  ADD COLUMN lock_token TEXT,
  ADD COLUMN last_error TEXT;

-- Tier started at zero when this outbox was introduced. Recover the preceding
-- tier from event history without recreating events or resetting published rows.
WITH history AS (
  SELECT id, COALESCE(LAG((payload->'data'->>'kycTier')::integer) OVER (
    PARTITION BY aggregate_id ORDER BY aggregate_version
  ), 0) AS previous_tier
  FROM user_outbox_events WHERE event_type = 'user.kyc_updated'
)
UPDATE user_outbox_events e
SET payload = jsonb_set(e.payload, '{data,previousTier}', to_jsonb(h.previous_tier))
FROM history h
WHERE e.id = h.id AND e.status = 'PENDING'
  AND e.payload->>'eventVersion' = '1'
  AND NOT (e.payload->'data' ? 'previousTier');
