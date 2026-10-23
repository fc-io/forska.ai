export const getComparisonProjectConflictResolutionImportSourcesSql = (params: {
  comparisonProjectConflictResolutionTable: string
  comparisonProjectTable: string
}) => {
  return `
    SELECT
      cp.id AS id,
      cp.name AS name,
      cp.description AS description,
      cp.created_at AS createdAt,
      cp.human_judgment_mode AS humanJudgmentMode,
      COUNT(cr.article_id) AS resolutionCount
    FROM ${params.comparisonProjectTable} cp
    INNER JOIN ${params.comparisonProjectConflictResolutionTable} cr
      ON cr.comparison_project_id = cp.id
    WHERE cp.archived = FALSE
      AND cp.allow_conflict_resolution = TRUE
      AND cp.human_judgment_mode = 'summary'
    GROUP BY
      cp.id,
      cp.name,
      cp.description,
      cp.created_at,
      cp.human_judgment_mode
    ORDER BY cp.created_at DESC, cp.name ASC, cp.id ASC
  `
}
