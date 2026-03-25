UPDATE app.user_config
SET unpaywall_email = NULL,
    updated_at = current_timestamp
WHERE unpaywall_email IS NOT NULL
  AND email IS NOT NULL
  AND unpaywall_email = email;
