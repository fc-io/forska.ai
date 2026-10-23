import {getArticleUrl} from '../../../../app/utils/getArticleUrl.ts'
import type {ArticleRecord} from '../../../../db/schemaTypes.ts'
import {getArticleSourceMetadataValue} from '../../../../utils/articleSourceMetadata.ts'
import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {getProjectReviewDetailsWorkloadContext} from './getProjectReviewDetailsWorkloadContext.ts'

type CovidenceRelatedRecord = {
  articleExternalId: string | null
  articleTitle: string
  articleUrl: string | null
  covidenceIds: string[]
  hasDuplicateStudyRecords: boolean
  hasStudyDecisionConflict: boolean
  id: string
  isCurrentRecord: boolean
  isSeededHumanJudgmentAnswered: boolean
  referenceIds: string[]
  seededHumanJudgmentAnswer: string | null
  stageMembership: Record<string, boolean>
}

type CovidenceRelatedRecordsResult = {overflow: boolean; records: CovidenceRelatedRecord[]}

const covidenceRelatedRecordsLimit = 500
const covidenceRelatedRecordsQueryLimit = covidenceRelatedRecordsLimit + 1

export const getCovidenceRelatedRecords = async (params: {
  article: ArticleRecord
  projectId: string
}): Promise<CovidenceRelatedRecordsResult> => {
  const article = params.article
  const covidence = getArticleSourceMetadataValue(article.sourceMetadata)?.covidence

  if (!covidence?.studyKey) {
    return {overflow: false, records: []}
  }

  const rows = await getAppDatabaseService().queryJson<{
    articleExternalId: string | null
    articleTitle: string
    arxivId: string | null
    biorxivId: string | null
    doi: string | null
    id: string
    isCurrentRecord: boolean
    medrxivId: string | null
    pubmedId: string | null
    rawPayload: unknown
    sourceMetadata: unknown
    url: string | null
  }>(
    `
    WITH project_route AS (
      SELECT import_route_id
      FROM app.project_import_route
      WHERE project_id = ${getSqlLiteral(params.projectId)}
    ),
    source_record_related_record AS (
      SELECT
        source_record.id AS id,
        source_record.external_article_id AS articleExternalId,
        article.article_title AS articleTitle,
        article.arxiv_id AS arxivId,
        article.biorxiv_id AS biorxivId,
        article.doi AS doi,
        article.medrxiv_id AS medrxivId,
        article.pubmed_id AS pubmedId,
        COALESCE(json_extract_string(source_record.raw_payload, '$.covidence.citation.url'), article.url) AS url,
        source_record.article_id = ${getSqlLiteral(article.id)} AS isCurrentRecord,
        source_record.raw_payload AS rawPayload,
        source_record.import_metadata AS sourceMetadata
      FROM app.article_import_route_source_record source_record
      INNER JOIN project_route ON project_route.import_route_id = source_record.import_route_id
      INNER JOIN app.article article ON article.id = source_record.article_id
      WHERE source_record.quarantined_at IS NULL
        AND json_extract_string(source_record.import_metadata, '$.covidence.studyKey') = ${getSqlLiteral(covidence.studyKey)}
    ),
    legacy_related_record AS (
      SELECT
        article.id AS id,
        article.article_id AS articleExternalId,
        article.article_title AS articleTitle,
        article.arxiv_id AS arxivId,
        article.biorxiv_id AS biorxivId,
        article.doi AS doi,
        article.medrxiv_id AS medrxivId,
        article.pubmed_id AS pubmedId,
        article.url AS url,
        article.id = ${getSqlLiteral(article.id)} AS isCurrentRecord,
        article.original_data AS rawPayload,
        article.source_metadata AS sourceMetadata
      FROM app.article article
      WHERE article.import_route = ${getSqlLiteral(article.importRoute)}
        AND json_extract_string(article.source_metadata, '$.covidence.studyKey') = ${getSqlLiteral(covidence.studyKey)}
    )
    SELECT * FROM source_record_related_record
    UNION ALL
    SELECT * FROM legacy_related_record
    WHERE NOT EXISTS (
      SELECT 1
      FROM source_record_related_record source_record
      WHERE source_record.id = legacy_related_record.id
    )
    ORDER BY isCurrentRecord DESC, articleTitle ASC, articleExternalId ASC NULLS LAST, id ASC
    LIMIT ${covidenceRelatedRecordsQueryLimit}
  `,
    getProjectReviewDetailsWorkloadContext({
      maxResultRows: covidenceRelatedRecordsQueryLimit,
      operation: 'covidenceRelatedRecords',
      projectId: params.projectId,
    }),
  )

  const visibleRows = rows.slice(0, covidenceRelatedRecordsLimit)

  return {
    overflow: rows.length > covidenceRelatedRecordsLimit,
    records: visibleRows.map((row) => {
      const sourceMetadata = getJsonValue(row.sourceMetadata)
      const relatedCovidence = getArticleSourceMetadataValue(sourceMetadata)?.covidence

      return {
        articleExternalId: row.articleExternalId,
        articleTitle: row.articleTitle,
        articleUrl:
          getArticleUrl({
            arxivId: row.arxivId,
            biorxivId: row.biorxivId,
            doi: row.doi,
            medrxivId: row.medrxivId,
            originalData: getJsonValue(row.rawPayload),
            pubmedId: row.pubmedId,
            sourceMetadata,
            url: row.url,
          }) || null,
        covidenceIds: relatedCovidence?.covidenceIds ?? [],
        hasDuplicateStudyRecords: relatedCovidence?.hasDuplicateStudyRecords ?? false,
        hasStudyDecisionConflict: relatedCovidence?.hasStudyDecisionConflict ?? false,
        id: row.id,
        isCurrentRecord: row.isCurrentRecord || row.id === article.id,
        isSeededHumanJudgmentAnswered: relatedCovidence?.isSeededHumanJudgmentAnswered ?? false,
        referenceIds: relatedCovidence?.referenceIds ?? [],
        seededHumanJudgmentAnswer: relatedCovidence?.seededHumanJudgmentAnswer ?? null,
        stageMembership: relatedCovidence?.stageMembership ?? {},
      }
    }),
  }
}
