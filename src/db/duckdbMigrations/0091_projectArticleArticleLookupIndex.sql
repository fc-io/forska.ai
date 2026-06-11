CREATE INDEX IF NOT EXISTS idx_app_project_article_article_id
ON app.project_article(article_id, project_id);

CREATE INDEX IF NOT EXISTS idx_app_project_import_route_import_route_id
ON app.project_import_route(import_route_id, project_id);
