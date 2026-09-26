-- Incremental projectScope patches used to acknowledge import-route article additions without writing
-- mart.project_scope_article, so articles imported after the legacy project mart refresh worker was removed
-- never reached their projects' review serving snapshots. Reopen the added deltas of every article that an
-- unarchived project on the route should scope but does not; delta intake then queues fresh dirty work for it.

UPDATE app.import_run_article_delta
SET reconciled_at = NULL
WHERE change_kind = 'importRoute.article.added'
  AND reconciled_at IS NOT NULL
  AND delta_id IN (
    SELECT delta.delta_id
    FROM app.import_run_article_delta delta
    INNER JOIN app.project_import_route project_route
      ON project_route.import_route_id = delta.import_route_id
    INNER JOIN app.project project
      ON project.id = project_route.project_id
      AND project.archived = FALSE
    INNER JOIN app.article_import_route article_route
      ON article_route.import_route_id = delta.import_route_id
      AND article_route.article_id = delta.article_id
    INNER JOIN app.article article
      ON article.id = delta.article_id
    LEFT JOIN mart.project_scope_article scope
      ON scope.project_id = project.id
      AND scope.article_id = delta.article_id
    WHERE delta.change_kind = 'importRoute.article.added'
      AND delta.reconciled_at IS NOT NULL
      AND scope.article_id IS NULL
      AND (project.date_from IS NULL OR article.article_created_at >= project.date_from)
      AND (project.date_to IS NULL OR article.article_created_at <= project.date_to)
  );
