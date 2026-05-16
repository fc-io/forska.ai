CREATE UNIQUE INDEX IF NOT EXISTS idx_app_model_provider_remote_variant_unique
ON app.model(provider_connection_id, remote_model_id, COALESCE(variant, ''));
