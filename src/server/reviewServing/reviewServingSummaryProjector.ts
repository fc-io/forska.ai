import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson} from './reviewProjectionIdentity.ts'
import {
  namedReviewFastCountDefinitions,
  type NamedReviewFastCountKey,
  type ReviewServingCountAvailability,
} from './reviewServingContracts.ts'
import {
  prepareReviewServingContributionDiff,
  type ReviewServingContributionDiff,
  type ReviewServingContributionRow,
} from './reviewServingContributionService.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'

export type ReviewServingSummaryProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingSummariesInput = {
  claims: readonly ReviewServingDirtyWorkClaim[]
  listModeKeys: readonly string[]
  projectId: string
  projectionIdentity: string
  reviewConfigHash: string
  snapshotId: string
}

type SummaryContributionSourceRow = {
  answerId: number | null
  answerValue: string | null
  articleId: string
  availability: ReviewServingCountAvailability
  countKind: NamedReviewFastCountKey | null
  facetKind: string | null
  facetKey: string | null
  facetValue: string | null
  filterKey: string | null
  listModeKey: string | null
  promptId: string | null
  staleReason: string | null
  summaryIdentity: string
  summaryKind: 'count' | 'facet'
}

type SummaryContributionIdentity = Omit<SummaryContributionSourceRow, 'articleId'>

type ExistingCountRow = {countKind: string; countValue: number | null; filterKey: string; listModeKey: string}

type ExistingFacetRow = {countValue: number | null; facetKey: string; facetValue: string; summaryIdentity: string}

const summaryProjectorName = 'summary-projector'
const dynamicFilteredTotalFilterKey = 'filter:dynamic'

const getPatchWatermark = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return Math.max(
    0,
    ...claims.map((claim) => {
      return claim.latestSourceHighWaterMark
    }),
  )
}

const getPatchRangeStart = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return Math.min(
    ...claims.map((claim) => {
      return claim.firstSourceHighWaterMark
    }),
  )
}

const getClaimSourcePartition = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return claims[0]?.sourcePartition ?? 'review-change'
}

const getClaimKinds = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return [
    ...new Set(
      claims.map((claim) => {
        return claim.dirtyKind
      }),
    ),
  ].join(',')
}

const getClaimArticleIds = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return [
    ...new Set(
      claims
        .map((claim) => {
          return claim.articleId ?? (claim.scopeKind === 'article' ? (claim.scopeId.split(':').at(-1) ?? null) : null)
        })
        .filter((articleId) => {
          return articleId !== null && articleId.trim().length > 0
        }) as string[],
    ),
  ]
}

const getValuesCte = (columnName: string, values: readonly string[]) => {
  return values.length === 0
    ? ''
    : `${columnName}_filter(${columnName}) AS (SELECT * FROM (VALUES ${values
        .map((value) => {
          return `(${getSqlLiteral(value)})`
        })
        .join(', ')}))`
}

const getListModeCte = (listModeKeys: readonly string[]) => {
  return getValuesCte('list_mode_key', listModeKeys)
}

const getSummaryDefinitionVersion = (identity: Pick<SummaryContributionIdentity, 'countKind'>) => {
  return identity.countKind === null
    ? null
    : namedReviewFastCountDefinitions[identity.countKind].summaryDefinitionVersion
}

const getSummaryContributionKey = (row: SummaryContributionIdentity) => {
  return getStableReviewServingJson(row as unknown as Record<string, unknown>)
}

const parseSummaryContributionKey = (contributionKey: string): SummaryContributionIdentity | null => {
  try {
    return JSON.parse(contributionKey) as SummaryContributionIdentity
  } catch (_error) {
    return null
  }
}

const getSummaryContributionRows = async (
  input: ProjectReviewServingSummariesInput,
  database: ReviewServingSummaryProjectorDatabase,
) => {
  const articleIds = getClaimArticleIds(input.claims)

  return articleIds.length === 0 || input.listModeKeys.length === 0
    ? []
    : database.queryJson<SummaryContributionSourceRow>(`
        WITH ${getValuesCte('article_id', articleIds)},
        ${getListModeCte(input.listModeKeys)},
        scoped_article AS (
          SELECT
            scope.article_id,
            scope.publication_year,
            scope.in_curated_scope OR scope.in_route_scope AS in_scope
          FROM article_id_filter dirty
          INNER JOIN mart.project_scope_article scope
            ON scope.project_id = ${getSqlLiteral(input.projectId)}
            AND scope.article_id = dirty.article_id
        ),
        selected_state AS (
          SELECT
            scoped.article_id,
            COALESCE(selected_patch.import_route_id, selected_base.import_route_id) AS import_route_id,
            COALESCE(selected_patch.publication_year, selected_base.publication_year, scoped.publication_year) AS publication_year,
            COALESCE(selected_patch.duplicate_flag, selected_base.duplicate_flag) AS duplicate_flag,
            COALESCE(selected_patch.conflict_flag, selected_base.conflict_flag) AS conflict_flag,
            scoped.in_scope AND NOT COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE) AS in_selected_scope
          FROM scoped_article scoped
          LEFT JOIN app.review_selected_article_import_v4 selected_base
            ON selected_base.project_id = ${getSqlLiteral(input.projectId)}
            AND selected_base.article_id = scoped.article_id
          LEFT JOIN mart.review_selected_import_patch_v4 selected_patch
            ON selected_patch.project_id = ${getSqlLiteral(input.projectId)}
            AND selected_patch.article_id = scoped.article_id
        ),
        base_counts AS (
          SELECT selected.article_id AS articleId, 'count' AS summaryKind, 'review.list.total' AS countKind, 'list:all' AS filterKey, list_mode_key.list_mode_key AS listModeKey, 'review.list.total' AS summaryIdentity, NULL AS facetKind, NULL AS facetKey, NULL AS facetValue, NULL AS promptId, NULL AS answerId, NULL AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM selected_state selected CROSS JOIN list_mode_key_filter list_mode_key
          WHERE selected.in_selected_scope
          UNION ALL
          SELECT selected.article_id AS articleId, 'count' AS summaryKind, 'review.list.filteredTotal' AS countKind, ${getSqlLiteral(dynamicFilteredTotalFilterKey)} AS filterKey, list_mode_key.list_mode_key AS listModeKey, 'review.list.filteredTotal' AS summaryIdentity, NULL AS facetKind, NULL AS facetKey, NULL AS facetValue, NULL AS promptId, NULL AS answerId, NULL AS answerValue, 'unavailable' AS availability, 'dynamic filter/search scopes require a precomputed filter signature' AS staleReason
          FROM selected_state selected CROSS JOIN list_mode_key_filter list_mode_key
          WHERE selected.in_selected_scope
        ),
        selected_facets AS (
          SELECT selected.article_id AS articleId, 'facet' AS summaryKind, 'review.filter.duplicateFlag' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.filter.duplicateFlag' AS summaryIdentity, 'review' AS facetKind, 'duplicateFlag' AS facetKey, CAST(selected.duplicate_flag AS VARCHAR) AS facetValue, NULL AS promptId, NULL AS answerId, CAST(selected.duplicate_flag AS VARCHAR) AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM selected_state selected WHERE selected.in_selected_scope AND selected.duplicate_flag IS NOT NULL
          UNION ALL
          SELECT selected.article_id AS articleId, 'facet' AS summaryKind, 'review.filter.importRoute' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.filter.importRoute' AS summaryIdentity, 'review' AS facetKind, 'importRoute' AS facetKey, selected.import_route_id AS facetValue, NULL AS promptId, NULL AS answerId, selected.import_route_id AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM selected_state selected WHERE selected.in_selected_scope AND selected.import_route_id IS NOT NULL
          UNION ALL
          SELECT selected.article_id AS articleId, 'facet' AS summaryKind, 'review.filter.publicationYear' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.filter.publicationYear' AS summaryIdentity, 'review' AS facetKind, 'publicationYear' AS facetKey, CAST(selected.publication_year AS VARCHAR) AS facetValue, NULL AS promptId, NULL AS answerId, CAST(selected.publication_year AS VARCHAR) AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM selected_state selected WHERE selected.in_selected_scope AND selected.publication_year IS NOT NULL
        ),
        llm_counts AS (
          SELECT llm.article_id AS articleId, 'count' AS summaryKind, 'review.llm.assessedByPrompt' AS countKind, concat('prompt:', llm.prompt_id) AS filterKey, llm.list_mode_key AS listModeKey, 'review.llm.assessedByPrompt' AS summaryIdentity, NULL AS facetKind, NULL AS facetKey, NULL AS facetValue, llm.prompt_id AS promptId, NULL AS answerId, NULL AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM mart.review_llm_status_patch_v4 llm
          INNER JOIN article_id_filter dirty ON dirty.article_id = llm.article_id
          INNER JOIN list_mode_key_filter list_mode_key ON list_mode_key.list_mode_key = llm.list_mode_key
          WHERE llm.project_id = ${getSqlLiteral(input.projectId)} AND llm.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)} AND NOT llm.tombstone AND llm.llm_status_key = 'answered'
        ),
        human_counts AS (
          SELECT human.article_id AS articleId, 'count' AS summaryKind, 'review.human.reviewedByPrompt' AS countKind, concat('prompt:', human.prompt_id) AS filterKey, human.list_mode_key AS listModeKey, 'review.human.reviewedByPrompt' AS summaryIdentity, NULL AS facetKind, NULL AS facetKey, NULL AS facetValue, human.prompt_id AS promptId, NULL AS answerId, NULL AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM mart.review_human_status_patch_v4 human
          INNER JOIN article_id_filter dirty ON dirty.article_id = human.article_id
          INNER JOIN list_mode_key_filter list_mode_key ON list_mode_key.list_mode_key = human.list_mode_key
          WHERE human.project_id = ${getSqlLiteral(input.projectId)} AND NOT human.tombstone AND human.human_status_key = 'answered'
        ),
        answer_facets AS (
          SELECT llm.article_id AS articleId, 'facet' AS summaryKind, 'review.filter.promptAnswer' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.filter.promptAnswer' AS summaryIdentity, 'review' AS facetKind, 'promptAnswer' AS facetKey, llm.answered_original AS facetValue, llm.prompt_id AS promptId, NULL AS answerId, llm.answered_original AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM mart.review_llm_status_patch_v4 llm
          INNER JOIN article_id_filter dirty ON dirty.article_id = llm.article_id
          WHERE llm.project_id = ${getSqlLiteral(input.projectId)} AND llm.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)} AND NOT llm.tombstone AND llm.answered_original IS NOT NULL
          UNION ALL
          SELECT human.article_id AS articleId, 'facet' AS summaryKind, 'review.human.filter.promptAnswer' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.human.filter.promptAnswer' AS summaryIdentity, 'human' AS facetKind, 'promptAnswer' AS facetKey, human.human_answered_value AS facetValue, human.prompt_id AS promptId, NULL AS answerId, human.human_answered_value AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM mart.review_human_status_patch_v4 human
          INNER JOIN article_id_filter dirty ON dirty.article_id = human.article_id
          WHERE human.project_id = ${getSqlLiteral(input.projectId)} AND NOT human.tombstone AND human.prompt_id <> 'summary' AND human.human_answered_value IS NOT NULL
          UNION ALL
          SELECT human.article_id AS articleId, 'facet' AS summaryKind, 'review.human.filter.summaryAnswer' AS countKind, NULL AS filterKey, NULL AS listModeKey, 'review.human.filter.summaryAnswer' AS summaryIdentity, 'human' AS facetKind, 'summaryAnswer' AS facetKey, human.human_answered_value AS facetValue, human.prompt_id AS promptId, NULL AS answerId, human.human_answered_value AS answerValue, 'ready' AS availability, NULL AS staleReason
          FROM mart.review_human_status_patch_v4 human
          INNER JOIN article_id_filter dirty ON dirty.article_id = human.article_id
          WHERE human.project_id = ${getSqlLiteral(input.projectId)} AND NOT human.tombstone AND human.prompt_id = 'summary' AND human.human_answered_value IS NOT NULL
        ),
        summary_union AS (
          SELECT * FROM base_counts
          UNION ALL SELECT * FROM selected_facets
          UNION ALL SELECT * FROM llm_counts
          UNION ALL SELECT * FROM human_counts
          UNION ALL SELECT * FROM answer_facets
        )
        SELECT * FROM summary_union
      `)
}

const getRowsAsContributionRows = (rows: readonly SummaryContributionSourceRow[]) => {
  return rows.map((row): ReviewServingContributionRow => {
    return {
      articleId: row.articleId,
      contributionKey: getSummaryContributionKey({
        answerId: row.answerId,
        answerValue: row.answerValue,
        availability: row.availability,
        countKind: row.countKind,
        facetKind: row.facetKind,
        facetKey: row.facetKey,
        facetValue: row.facetValue,
        filterKey: row.filterKey,
        listModeKey: row.listModeKey,
        promptId: row.promptId,
        staleReason: row.staleReason,
        summaryIdentity: row.summaryIdentity,
        summaryKind: row.summaryKind,
      }),
      contributionValue: 1,
    }
  })
}

const getExistingCountRows = async (
  input: ProjectReviewServingSummariesInput,
  database: ReviewServingSummaryProjectorDatabase,
) => {
  return database.queryJson<ExistingCountRow>(`
    SELECT count_kind AS countKind, filter_key AS filterKey, list_mode_key AS listModeKey, CAST(count_value AS DOUBLE) AS countValue
    FROM mart.review_article_count_serving_v4
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
  `)
}

const getExistingFacetRows = async (
  input: ProjectReviewServingSummariesInput,
  database: ReviewServingSummaryProjectorDatabase,
) => {
  return database.queryJson<ExistingFacetRow>(`
    SELECT summary_identity AS summaryIdentity, facet_key AS facetKey, facet_value AS facetValue, CAST(count_value AS DOUBLE) AS countValue
    FROM mart.review_filter_facet_serving_v4
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
  `)
}

const getCountRecord = (input: {
  countValue: number | null
  identity: SummaryContributionIdentity
  projectId: string
  reviewConfigHash: string
  snapshotId: string
}): ReviewServingProjectorRecord | null => {
  const summaryDefinitionVersion = getSummaryDefinitionVersion(input.identity)

  return input.identity.countKind === null || input.identity.filterKey === null || summaryDefinitionVersion === null
    ? null
    : {
        keyColumns: [
          'project_id',
          'review_config_hash',
          'snapshot_id',
          'list_mode_key',
          'count_kind',
          'summary_definition_version',
          'filter_key',
        ],
        table: 'mart.review_article_count_serving_v4',
        values: {
          availability: input.identity.availability,
          count_kind: input.identity.countKind,
          count_updated_at: new Date(),
          count_value: input.identity.availability === 'ready' ? input.countValue : null,
          filter_key: input.identity.filterKey,
          list_mode_key: input.identity.listModeKey ?? 'global',
          project_id: input.projectId,
          review_config_hash: input.reviewConfigHash,
          snapshot_id: input.snapshotId,
          stale_reason: input.identity.staleReason,
          summary_definition_version: summaryDefinitionVersion,
          summary_identity: input.identity.summaryIdentity,
        },
      }
}

const getFacetRecord = (input: {
  countValue: number | null
  identity: SummaryContributionIdentity
  projectId: string
  reviewConfigHash: string
  snapshotId: string
}): ReviewServingProjectorRecord | null => {
  const summaryDefinitionVersion = getSummaryDefinitionVersion(input.identity)

  return input.identity.countKind === null
    || input.identity.facetKind === null
    || input.identity.facetKey === null
    || input.identity.facetValue === null
    || summaryDefinitionVersion === null
    ? null
    : {
        keyColumns: [
          'project_id',
          'review_config_hash',
          'snapshot_id',
          'summary_identity',
          'facet_kind',
          'facet_key',
          'facet_value',
          'summary_definition_version',
        ],
        table: 'mart.review_filter_facet_serving_v4',
        values: {
          answer_id: input.identity.answerId,
          answer_value: input.identity.answerValue,
          availability: input.identity.availability,
          count_value: input.identity.availability === 'ready' ? input.countValue : null,
          facet_key: input.identity.facetKey,
          facet_kind: input.identity.facetKind,
          facet_updated_at: new Date(),
          facet_value: input.identity.facetValue,
          project_id: input.projectId,
          prompt_id: input.identity.promptId,
          review_config_hash: input.reviewConfigHash,
          snapshot_id: input.snapshotId,
          summary_definition_version: summaryDefinitionVersion,
          summary_identity: input.identity.summaryIdentity,
        },
      }
}

const getSummaryRecord = (input: {
  countValue: number | null
  identity: SummaryContributionIdentity
  projectId: string
  reviewConfigHash: string
  snapshotId: string
}) => {
  return input.identity.summaryKind === 'count' ? getCountRecord(input) : getFacetRecord(input)
}

const getCountExistingKey = (row: Pick<ExistingCountRow, 'countKind' | 'filterKey' | 'listModeKey'>) => {
  return getStableReviewServingJson({countKind: row.countKind, filterKey: row.filterKey, listModeKey: row.listModeKey})
}

const getFacetExistingKey = (row: Pick<ExistingFacetRow, 'facetKey' | 'facetValue' | 'summaryIdentity'>) => {
  return getStableReviewServingJson({
    facetKey: row.facetKey,
    facetValue: row.facetValue,
    summaryIdentity: row.summaryIdentity,
  })
}

const getIdentityExistingValueKey = (identity: SummaryContributionIdentity) => {
  return identity.summaryKind === 'count'
    ? getStableReviewServingJson({
        countKind: identity.countKind,
        filterKey: identity.filterKey,
        listModeKey: identity.listModeKey ?? 'global',
      })
    : getStableReviewServingJson({
        facetKey: identity.facetKey,
        facetValue: identity.facetValue,
        summaryIdentity: identity.summaryIdentity,
      })
}

const getSummaryRecords = async (input: {
  database: ReviewServingSummaryProjectorDatabase
  diffs: readonly ReviewServingContributionDiff[]
  projectorInput: ProjectReviewServingSummariesInput
}) => {
  const [countRows, facetRows] = await Promise.all([
    getExistingCountRows(input.projectorInput, input.database),
    getExistingFacetRows(input.projectorInput, input.database),
  ])
  const existingValues = new Map<string, number>([
    ...countRows.map((row) => {
      return [getCountExistingKey(row), row.countValue ?? 0] as const
    }),
    ...facetRows.map((row) => {
      return [getFacetExistingKey(row), row.countValue ?? 0] as const
    }),
  ])

  return input.diffs.flatMap((diff) => {
    const identity = parseSummaryContributionKey(diff.contributionKey)
    const existingValue = identity === null ? 0 : (existingValues.get(getIdentityExistingValueKey(identity)) ?? 0)
    const record =
      identity === null
        ? null
        : getSummaryRecord({
            countValue: Math.max(0, existingValue + diff.delta),
            identity,
            projectId: input.projectorInput.projectId,
            reviewConfigHash: input.projectorInput.reviewConfigHash,
            snapshotId: input.projectorInput.snapshotId,
          })

    return record === null ? [] : [record]
  })
}

export const projectReviewServingSummaries = async (
  input: ProjectReviewServingSummariesInput,
  database: ReviewServingSummaryProjectorDatabase = getAppDatabaseService(),
) => {
  const sourceRows = await getSummaryContributionRows(input, database)
  const contributionDiff = await prepareReviewServingContributionDiff(
    {
      claims: input.claims,
      componentKind: 'count',
      expectedArticleIds: getClaimArticleIds(input.claims),
      newRows: getRowsAsContributionRows(sourceRows),
      projectId: input.projectId,
      projectionComponent: 'summary',
      projectionIdentity: input.projectionIdentity,
      repairDirtyKind: 'project.reviewConfig.updated',
      reviewConfigHash: input.reviewConfigHash,
      snapshotId: input.snapshotId,
      summaryDefinitionVersion: 'review-serving-summary:v1',
    },
    database,
  )
  const summaryRecords = await getSummaryRecords({database, diffs: contributionDiff.diffs, projectorInput: input})
  const patchWatermark = getPatchWatermark(input.claims)

  await writeReviewServingProjectorComponent(
    {
      acknowledgements: input.claims,
      component: 'summary',
      projectionManifests:
        input.claims.length === 0
          ? []
          : [
              {
                baseGeneration: 0,
                definitionVersion: 'review-serving-summary:v1',
                inputDigest: getClaimKinds(input.claims),
                inputWatermark: patchWatermark,
                invalidationReason: getClaimKinds(input.claims),
                patchRangeEnd: patchWatermark,
                patchRangeStart: getPatchRangeStart(input.claims),
                patchWatermark,
                projectId: input.projectId,
                projectionComponent: 'summary',
                projectionIdentity: input.projectionIdentity,
                status: 'candidate',
              },
            ],
      records: [...summaryRecords, ...contributionDiff.contributionRecords],
      repairDirtyWork: contributionDiff.repairDirtyWork,
      statements:
        contributionDiff.deleteContributionStateStatement === null
          ? []
          : [contributionDiff.deleteContributionStateStatement],
      watermark:
        input.claims.length === 0
          ? undefined
          : {
              projectId: input.projectId,
              projectionComponent: 'summary',
              projectorName: summaryProjectorName,
              sourceHighWaterMark: patchWatermark,
              sourcePartition: getClaimSourcePartition(input.claims),
            },
    },
    database,
  )

  return {
    contributionRowCount: contributionDiff.contributionRecords.length,
    repairRequired: contributionDiff.repairRequired,
    summaryRowCount: summaryRecords.length,
    summaryValues: summaryRecords.map((record) => {
      return record.values
    }),
  }
}
