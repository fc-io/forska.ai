ALTER TABLE app.review_write_overlay
ADD COLUMN IF NOT EXISTS read_surface VARCHAR DEFAULT 'row';
