ALTER TABLE app.project_transfer_session
ADD COLUMN IF NOT EXISTS terminal_cleanup_at TIMESTAMPTZ;
