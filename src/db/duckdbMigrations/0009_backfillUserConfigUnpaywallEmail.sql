UPDATE app.user_config
SET unpaywall_email = email,
    updated_at = current_timestamp
WHERE unpaywall_email IS NULL
  AND email IS NOT NULL;
