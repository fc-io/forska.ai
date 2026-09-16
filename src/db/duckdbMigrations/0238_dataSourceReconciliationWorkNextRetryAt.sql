ALTER TABLE app.data_source_reconciliation_work
ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
