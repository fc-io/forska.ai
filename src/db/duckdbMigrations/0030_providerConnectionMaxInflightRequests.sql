ALTER TABLE app.provider_connection
ADD COLUMN IF NOT EXISTS max_inflight_requests INTEGER;
