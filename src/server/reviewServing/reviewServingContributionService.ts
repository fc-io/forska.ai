import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type ReviewServingChangeKind, type ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {type ReviewServingDirtyWorkClaim, type ReviewServingDirtyWorkInput} from './reviewServingDirtyWorkService.ts'
import {
  getDeleteReviewServingProjectorRowsStatement,
  type ReviewServingProjectorRecord,
  type ReviewServingProjectorWriterDatabase,
} from './reviewServingProjectorWriter.ts'

export type ReviewServingContributionComponentKind = 'badge' | 'count' | 'facet' | 'posting' | 'queue'

export type ReviewServingContributionRow = {articleId: string; contributionKey: string; contributionValue: number}

export type StoredReviewServingContributionRow = ReviewServingContributionRow & {summaryDefinitionVersion: string}

export type ReviewServingContributionDiff = {contributionKey: string; delta: number}

export type PrepareReviewServingContributionDiffInput = {
  claims: readonly ReviewServingDirtyWorkClaim[]
  componentKind: ReviewServingContributionComponentKind
  expectedArticleIds: readonly string[]
  newRows: readonly ReviewServingContributionRow[]
  projectId: string
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
  repairDirtyKind?: ReviewServingChangeKind
  requireExistingState?: boolean
  reviewConfigHash: string
  snapshotId: string
  summaryDefinitionVersion: string
}

export type PreparedReviewServingContributionDiff = {
  contributionRecords: readonly ReviewServingProjectorRecord[]
  deleteContributionStateStatement: string | null
  diffs: readonly ReviewServingContributionDiff[]
  repairDirtyWork: readonly ReviewServingDirtyWorkInput[]
  repairRequired: boolean
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

const getUniqueValues = (values: readonly string[]) => {
  return [...new Set(values)]
}

const getContributionDiffsFromRows = (input: {
  newRows: readonly ReviewServingContributionRow[]
  oldRows: readonly ReviewServingContributionRow[]
}) => {
  const oldDeltas = input.oldRows.reduce<Map<string, number>>((result, row) => {
    result.set(row.contributionKey, (result.get(row.contributionKey) ?? 0) - row.contributionValue)

    return result
  }, new Map())
  const deltas = input.newRows.reduce<Map<string, number>>((result, row) => {
    result.set(row.contributionKey, (result.get(row.contributionKey) ?? 0) + row.contributionValue)

    return result
  }, oldDeltas)

  return [...deltas.entries()]
    .filter(([, delta]) => {
      return delta !== 0
    })
    .map(([contributionKey, delta]) => {
      return {contributionKey, delta}
    })
}

const getCorruptedArticleIds = (rows: readonly ReviewServingContributionRow[]) => {
  return getUniqueValues(
    rows
      .filter((row) => {
        return !Number.isFinite(row.contributionValue)
      })
      .map((row) => {
        return row.articleId
      }),
  )
}

const getMissingArticleIds = (input: {
  expectedArticleIds: readonly string[]
  oldRows: readonly ReviewServingContributionRow[]
  requireExistingState: boolean
}) => {
  const articleIdsWithState = new Set(
    input.oldRows.map((row) => {
      return row.articleId
    }),
  )

  return input.requireExistingState
    ? input.expectedArticleIds.filter((articleId) => {
        return !articleIdsWithState.has(articleId)
      })
    : []
}

const getRepairDirtyWork = (input: {
  articleIds: readonly string[]
  claims: readonly ReviewServingDirtyWorkClaim[]
  projectId: string
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
  repairDirtyKind?: ReviewServingChangeKind
}) => {
  const highWaterMark = Math.max(
    0,
    ...input.claims.map((claim) => {
      return claim.latestSourceHighWaterMark
    }),
  )
  const firstClaim = input.claims[0]
  const sourcePartition = 'review-serving-contribution-repair' as const
  const dirtyKind =
    input.repairDirtyKind ?? ((firstClaim?.dirtyKind ?? 'project.reviewConfig.updated') as ReviewServingChangeKind)

  return getUniqueValues(input.articleIds).map((articleId) => {
    return {
      articleId,
      projectionComponent: input.projectionComponent,
      projectionIdentity: input.projectionIdentity,
      scope: {
        affectedComponents: [input.projectionComponent],
        dirtyKind,
        dirtyRangeEnd: articleId,
        dirtyRangeStart: articleId,
        firstAffectedComponent: input.projectionComponent,
        projectId: input.projectId,
        projectionKey: null,
        scopeId: `${input.projectId}:${articleId}`,
        scopeKind: 'article' as const,
        sourceHighWaterMark: highWaterMark,
        sourcePartition,
      },
    }
  })
}

const getContributionRecord = (input: {
  componentKind: ReviewServingContributionComponentKind
  projectId: string
  reviewConfigHash: string
  row: ReviewServingContributionRow
  snapshotId: string
  summaryDefinitionVersion: string
}): ReviewServingProjectorRecord => {
  return {
    keyColumns: [
      'project_id',
      'review_config_hash',
      'snapshot_id',
      'article_id',
      'component_kind',
      'summary_definition_version',
      'contribution_key',
    ],
    table: 'mart.review_article_summary_contribution_v4',
    values: {
      article_id: input.row.articleId,
      component_kind: input.componentKind,
      contribution_key: input.row.contributionKey,
      contribution_updated_at: new Date(),
      contribution_value: input.row.contributionValue,
      project_id: input.projectId,
      review_config_hash: input.reviewConfigHash,
      snapshot_id: input.snapshotId,
      summary_definition_version: input.summaryDefinitionVersion,
    },
  }
}

const getDeleteContributionStateStatement = (
  input: PrepareReviewServingContributionDiffInput,
  includeSummaryDefinitionVersion: boolean,
) => {
  const articleIds = getUniqueValues(input.expectedArticleIds)
  const summaryDefinitionVersionPredicate = includeSummaryDefinitionVersion
    ? {summary_definition_version: input.summaryDefinitionVersion}
    : {}

  return articleIds.length === 0
    ? null
    : getDeleteReviewServingProjectorRowsStatement({
        predicates: {
          article_id: articleIds,
          component_kind: input.componentKind,
          project_id: input.projectId,
          review_config_hash: input.reviewConfigHash,
          snapshot_id: input.snapshotId,
          ...summaryDefinitionVersionPredicate,
        },
        table: 'mart.review_article_summary_contribution_v4',
      })
}

const getStoredContributionRows = async (
  input: PrepareReviewServingContributionDiffInput,
  database: Pick<ReviewServingProjectorWriterDatabase, 'queryJson'>,
) => {
  const articleIds = getUniqueValues(input.expectedArticleIds)

  return articleIds.length === 0
    ? []
    : database.queryJson<StoredReviewServingContributionRow>(`
        WITH ${getValuesCte('article_id', articleIds)}
        SELECT
          contribution.article_id AS articleId,
          contribution.summary_definition_version AS summaryDefinitionVersion,
          contribution.contribution_key AS contributionKey,
          CAST(contribution.contribution_value AS DOUBLE) AS contributionValue
        FROM article_id_filter dirty
        INNER JOIN mart.review_article_summary_contribution_v4 contribution
          ON contribution.project_id = ${getSqlLiteral(input.projectId)}
          AND contribution.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND contribution.snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND contribution.component_kind = ${getSqlLiteral(input.componentKind)}
          AND contribution.article_id = dirty.article_id
      `)
}

export const getReviewServingContributionDiffs = (input: {
  newRows: readonly ReviewServingContributionRow[]
  oldRows: readonly ReviewServingContributionRow[]
}) => {
  return getContributionDiffsFromRows(input)
}

export const prepareReviewServingContributionDiff = async (
  input: PrepareReviewServingContributionDiffInput,
  database: Pick<ReviewServingProjectorWriterDatabase, 'queryJson'>,
): Promise<PreparedReviewServingContributionDiff> => {
  const storedRows = await getStoredContributionRows(input, database)
  const oldRows = storedRows.filter((row) => {
    return row.summaryDefinitionVersion === input.summaryDefinitionVersion
  })
  const incompatibleArticleIds = storedRows
    .filter((row) => {
      return row.summaryDefinitionVersion !== input.summaryDefinitionVersion
    })
    .map((row) => {
      return row.articleId
    })
  const corruptedArticleIds = getCorruptedArticleIds(oldRows)
  const finiteStoredRows = storedRows.filter((row) => {
    return Number.isFinite(row.contributionValue)
  })
  const missingArticleIds = getMissingArticleIds({
    expectedArticleIds: input.expectedArticleIds,
    oldRows,
    requireExistingState: input.requireExistingState ?? false,
  })
  const repairArticleIds = getUniqueValues([...incompatibleArticleIds, ...corruptedArticleIds, ...missingArticleIds])
  const repairRequired = repairArticleIds.length > 0
  const contributionRecords = input.newRows.map((row) => {
    return getContributionRecord({...input, row})
  })

  return {
    contributionRecords,
    deleteContributionStateStatement: getDeleteContributionStateStatement(input, !repairRequired),
    diffs: getContributionDiffsFromRows({newRows: input.newRows, oldRows: repairRequired ? finiteStoredRows : oldRows}),
    repairDirtyWork: repairRequired
      ? getRepairDirtyWork({
          articleIds: repairArticleIds,
          claims: input.claims,
          projectId: input.projectId,
          projectionComponent: input.projectionComponent,
          projectionIdentity: input.projectionIdentity,
          repairDirtyKind: input.repairDirtyKind,
        })
      : [],
    repairRequired,
  }
}
