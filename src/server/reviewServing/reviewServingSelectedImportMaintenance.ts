import {getSqlLiteral} from '../services/appQueryHelpers.ts'

export type ReviewServingSelectedImportMaintenanceDatabase = {run: (statement: string) => Promise<void>}

export const selectedImportPublishedTable = 'mart.review_selected_article_import_current_v4'
export const selectedImportStagingTable = 'mart.review_selected_article_import_staging_v4'

export const getDeleteSelectedImportPublishedSnapshotRowsStatement = (input: {
  projectId: string
  projectScopeIdentity: string
  selectedImportSnapshotId: string
}) => {
  return `
    DELETE FROM ${selectedImportPublishedTable}
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
      AND selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
  `
}

export const getDeleteSelectedImportStagingSnapshotRowsStatement = (input: {
  projectId: string
  projectScopeIdentity: string
  selectedImportSnapshotId: string
}) => {
  return `
    DELETE FROM ${selectedImportStagingTable}
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity)}
      AND selected_import_snapshot_id = ${getSqlLiteral(input.selectedImportSnapshotId)}
  `
}

export const deleteReviewServingSelectedImportSnapshotRows = async (
  input: {projectId: string; projectScopeIdentity: string; selectedImportSnapshotId: string},
  database: ReviewServingSelectedImportMaintenanceDatabase,
) => {
  await database.run(getDeleteSelectedImportPublishedSnapshotRowsStatement(input))
  await database.run(getDeleteSelectedImportStagingSnapshotRowsStatement(input))
}

export const getDeleteRetiredSelectedImportPublishedRowsStatement = (input: {
  activePinPredicateSql: string
  activeSnapshotManifestPredicateSql: string
  batchSize: number
  orderBySql: string
  projectId: string
  selectedImportProtectedPredicateSql: string
}) => {
  return `
    DELETE FROM ${selectedImportPublishedTable}
    WHERE rowid IN (
        SELECT candidate.rowid
        FROM ${selectedImportPublishedTable} candidate
        WHERE candidate.project_id = ${getSqlLiteral(input.projectId)}
          AND NOT (${input.activeSnapshotManifestPredicateSql})
          AND NOT (${input.selectedImportProtectedPredicateSql})
          AND NOT (${input.activePinPredicateSql})
        ORDER BY ${input.orderBySql}
        LIMIT ${getSqlLiteral(input.batchSize)}
      )
  `
}

export const getSelectedImportCurrentStartupMutationProbeSql = () => {
  return `
      DROP TABLE IF EXISTS startup_probe_review_selected_article_import_current_v4;
      CREATE TEMP TABLE startup_probe_review_selected_article_import_current_v4 AS
      WITH running_selected_import_ranges AS (
        SELECT
          project_id,
          chunk_start_key,
          chunk_end_key
        FROM app.review_rebuild_chunk_manifest
        WHERE projection_component = 'selectedImport'
          AND (
            status = 'running'
            OR COALESCE(last_error, '') LIKE '%Failed to delete all rows from index%'
            OR COALESCE(last_error, '') LIKE '%DuckDB%'
          )
        ORDER BY updated_at DESC, chunk_id ASC
        LIMIT 8
      ),
      running_selected_import_rows AS (
        SELECT selected_import.*
        FROM ${selectedImportPublishedTable} selected_import
        INNER JOIN running_selected_import_ranges running_range
          ON running_range.project_id = selected_import.project_id
         AND (
              running_range.chunk_start_key IS NULL
              OR selected_import.article_id >= running_range.chunk_start_key
            )
         AND (
              running_range.chunk_end_key IS NULL
              OR selected_import.article_id <= running_range.chunk_end_key
            )
        ORDER BY
          selected_import.project_id,
          selected_import.project_scope_identity,
          selected_import.selected_import_snapshot_id,
          selected_import.article_id
        LIMIT 64
      ),
      fallback_row AS (
        SELECT selected_import.*
        FROM ${selectedImportPublishedTable} selected_import
        WHERE NOT EXISTS (SELECT 1 FROM running_selected_import_rows)
        ORDER BY
          selected_import.project_id,
          selected_import.project_scope_identity,
          selected_import.selected_import_snapshot_id,
          selected_import.article_id
        LIMIT 1
      )
      SELECT *
      FROM running_selected_import_rows
      UNION ALL
      SELECT *
      FROM fallback_row;
      BEGIN;
      DELETE FROM ${selectedImportPublishedTable}
      WHERE EXISTS (
        SELECT 1
        FROM startup_probe_review_selected_article_import_current_v4 probe
        WHERE ${selectedImportPublishedTable}.project_id IS NOT DISTINCT FROM probe.project_id
          AND ${selectedImportPublishedTable}.project_scope_identity IS NOT DISTINCT FROM probe.project_scope_identity
          AND ${selectedImportPublishedTable}.selected_import_snapshot_id IS NOT DISTINCT FROM probe.selected_import_snapshot_id
          AND ${selectedImportPublishedTable}.article_id IS NOT DISTINCT FROM probe.article_id
      );
      INSERT INTO ${selectedImportPublishedTable} BY NAME
      SELECT *
      FROM startup_probe_review_selected_article_import_current_v4;
      COMMIT;
      DROP TABLE IF EXISTS startup_probe_review_selected_article_import_current_v4;
    `
}
