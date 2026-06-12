import {computePromptContentHash} from '../../utils/computePromptContentHash.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import {getDateValue, getSqlLiteral} from '../appQueryHelpers.ts'
import type {
  ProjectTransferConflictCounts,
  ProjectTransferOverlapCounts,
  ProjectTransferPlanBlocker,
} from './projectTransferContracts.ts'
import {getProjectTransferDuplicateImportDetection} from './projectTransferDuplicateDetection.ts'
import {
  getProjectTransferFidelityValidation,
  type ProjectTransferHumanReviewPlanEntry,
  type ProjectTransferJudgmentAssessmentPlanEntry,
  type ProjectTransferJudgmentConflictStatus,
  type ProjectTransferJudgmentPlanEntry,
} from './projectTransferFidelityValidation.ts'
import {
  getProjectTransferStrongIdentifierComparisonKeys,
  type ProjectTransferStrongIdentifierComparisonKey,
} from './projectTransferIdentifierNormalization.ts'
import {
  type ProjectTransferOperationTableRunner,
  withProjectTransferOperationTables,
} from './projectTransferOperationTables.ts'
import {validateProjectTransferRuntimeAssetPath} from './projectTransferPaths.ts'
import type {
  ProjectTransferArticlePayloadRecord,
  ProjectTransferAssetManifestEntry,
  ProjectTransferPayloadByKey,
  ProjectTransferPayloadRecord,
} from './projectTransferPayloadSchemas.ts'
import type {ProjectTransferPackageWarning} from './projectTransferSchemas.ts'
import type {ProjectTransferImportTempLayout} from './projectTransferSession.ts'

export type ProjectTransferAnalyzeTargetRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

type ProjectTransferAnalyzeTargetInput = {
  packageFingerprint: string | null
  payloads: Partial<ProjectTransferPayloadByKey>
  runner?: ProjectTransferAnalyzeTargetRunner
}

type ProjectTransferAnalyzeTargetOperationInput = Omit<ProjectTransferAnalyzeTargetInput, 'runner'> & {
  cwd?: string
  envValues?: Record<string, string | undefined>
  layout: ProjectTransferImportTempLayout
  operationId?: string
  runner?: ProjectTransferOperationTableRunner
}

type ImportedArticleMatchInput = {
  article: ProjectTransferArticlePayloadRecord
  identifierKeys: ProjectTransferStrongIdentifierComparisonKey[]
  packageArticleId: string | null
  sourceArticleId: string
}

type TargetArticleRow = {
  articleAuthors: unknown
  articleCreatedAt: unknown
  articleId: string | null
  articleSummary: string | null
  articleTitle: string | null
  articleUpdatedAt: unknown
  articleVersion: number | null
  arxivId: string | null
  biorxivId: string | null
  contentHash: string | null
  doi: string | null
  fullText: string | null
  fullTextAssets: unknown
  fullTextCharCount: number | null
  fullTextFetchedAt: unknown
  fullTextHtml: string | null
  fullTextOriginalFormat: string | null
  fullTextPdf: string | null
  fullTextSource: string | null
  importRoute: string | null
  medrxivId: string | null
  originalData: unknown
  publicationStatus: string | null
  pubmedId: string | null
  sourceMetadata: unknown
  targetArticleId: string
  url: string | null
}

type TargetArticleMatchedIdentifier = {identifierType: string; key: string; value: string}

type TargetArticleCandidate = {
  matchedIdentifiers: TargetArticleMatchedIdentifier[]
  targetArticle: TargetArticleRow
  targetArticleId: string
}

type ArticleMatchPlan = {
  action: 'blocked' | 'create' | 'reuse'
  candidates: TargetArticleCandidate[]
  conflicts: string[]
  identifierKeys: ProjectTransferStrongIdentifierComparisonKey[]
  packageArticleId: string | null
  selectedTargetArticleId: string | null
  sourceArticleId: string
}

type ArticleFieldFill = {assetDriven: boolean; assetPaths: string[]; field: string; value: unknown}

type ArticleUpdatePlan = {
  activeDirtiedProjectIds: string[]
  archivedReferencingProjectCount: number
  dateExpansionBlockers: ProjectTransferPlanBlocker[]
  fieldFills: ArticleFieldFill[]
  sourceArticleId: string
  targetArticleId: string
}

type AssetPromotionPlanEntry = {
  byteLength: number
  checksumSha256: string
  contentType?: string | null
  fields: string[]
  packagePath: string
  sourceArticleIds: string[]
  targetArticleIds: string[]
}

type TargetPromptRow = {archived: boolean; contentHash: string | null; targetPromptId: string}

type PromptPlanEntry = {
  action: 'create' | 'reuse'
  computedContentHash: string
  packageContentHash: string | null
  sourcePromptId: string
  targetPromptId: string | null
}

type ProjectPromptPlanEntry = {
  enabled: boolean
  metadata: Record<string, unknown>
  order: number | null
  sourceProjectPromptId: string
  sourcePromptId: string
  targetPromptId: string | null
}

type TargetImportRouteRow = {active: boolean; route: string; targetImportRouteId: string}

type RouteArticleRow = {articleCreatedAt: unknown; targetArticleId: string; targetImportRouteId: string}

type ProjectRouteReferenceRow = {
  archived: boolean
  dateFrom: unknown
  dateTo: unknown
  projectId: string
  targetImportRouteId: string
}

type ProjectArticleReferenceRow = {projectId: string; targetArticleId: string}

type ReferencingProjectRow = {
  archived: boolean
  dateFrom: unknown
  dateTo: unknown
  projectId: string
  targetArticleId: string
}

type ProjectRoutePlanEntry = {
  action: 'link' | 'omit'
  dateBoundedOutsideExportedArticleCount: number
  dateBoundedRouteArticleCount: number
  outsideExportedArticleCount: number
  sourceImportRouteId: string
  sourceProjectImportRouteId: string
  targetImportRouteId: string | null
}

type ArticleRoutePlanEntry = {
  action: 'exists' | 'omit' | 'write'
  sourceArticleId: string
  sourceArticleImportRouteId: string
  sourceImportRouteId: string
  snapshotProjectArticleLink: boolean
  targetArticleId: string | null
  targetImportRouteId: string | null
  unsafeProjectIds: string[]
}

export type ProjectTransferTargetPlan = {
  articleMatches: ArticleMatchPlan[]
  articleRoutePlan: ArticleRoutePlanEntry[]
  articleUpdatePlan: ArticleUpdatePlan[]
  assetPromotionPlan: AssetPromotionPlanEntry[]
  duplicateImportMatches: Awaited<ReturnType<typeof getProjectTransferDuplicateImportDetection>>['matches']
  humanReviewPlan?: ProjectTransferHumanReviewPlanEntry[]
  judgmentAssessmentPlan?: ProjectTransferJudgmentAssessmentPlanEntry[]
  judgmentPlan?: ProjectTransferJudgmentPlanEntry[]
  projectPromptPlan: ProjectPromptPlanEntry[]
  projectRoutePlan: ProjectRoutePlanEntry[]
  promptPlan: PromptPlanEntry[]
}

type ProjectTransferAnalyzeTargetResult = {
  blockers: ProjectTransferPlanBlocker[]
  conflictCounts: Omit<ProjectTransferConflictCounts, 'packageContractConflictCount'>
  judgmentConflictStatus: ProjectTransferJudgmentConflictStatus
  overlapCounts: ProjectTransferOverlapCounts
  packageWarnings: ProjectTransferPackageWarning[]
  targetPlan: ProjectTransferTargetPlan
}

const articleRuntimeAssetPathPattern = /assets\/[^\s"'<>)]*/g

const articleFillFields = [
  'articleAuthors',
  'articleCreatedAt',
  'articleSummary',
  'articleUpdatedAt',
  'articleVersion',
  'arxivId',
  'biorxivId',
  'contentHash',
  'doi',
  'fullText',
  'fullTextAssets',
  'fullTextCharCount',
  'fullTextFetchedAt',
  'fullTextHtml',
  'fullTextOriginalFormat',
  'fullTextPdf',
  'fullTextSource',
  'importRoute',
  'medrxivId',
  'originalData',
  'publicationStatus',
  'pubmedId',
  'sourceMetadata',
  'url',
] as const
const articleReferenceScanExcludedFields = new Set(['omissions', 'provenance', 'redactions', 'signature', 'warnings'])

const getRunner = (runner?: ProjectTransferAnalyzeTargetRunner) => {
  return runner ?? getAppDatabaseService()
}

export const getProjectTransferInitialOverlapCounts = (): ProjectTransferOverlapCounts => {
  return {
    currentReviewRowsSignatureHumanReviewCount: 0,
    currentReviewRowsSignatureJudgmentCount: 0,
    dirtiedExistingProjectCount: 0,
    duplicateImportMatchCount: 0,
    newArticleCount: 0,
    omittedArticleRouteLinkCount: 0,
    omittedRouteLinkCount: 0,
    reusedArticleAssetPromotionCount: 0,
    reusedArticleCount: 0,
    reusedArticleFieldFillCount: 0,
    reusedArticleUpdateCount: 0,
    reusedJudgmentCount: 0,
    routeArticleSnapshotLinkCount: 0,
    snapshotVerifiedJudgmentCount: 0,
    storedSignatureHumanReviewCount: 0,
    storedSignatureJudgmentCount: 0,
  }
}

export const getProjectTransferInitialConflictCounts = (
  packageContractConflictCount: number,
): ProjectTransferConflictCounts => {
  return {
    articleConflictCount: 0,
    humanReviewFidelityConflictCount: 0,
    judgmentConflictCount: 0,
    packageContractConflictCount,
    projectPromptConflictCount: 0,
  }
}

const getPlanBlocker = ({
  code,
  message,
  scope,
}: {
  code: string
  message: string
  scope: string
}): ProjectTransferPlanBlocker => {
  return {code, message, resolutionKind: 'requires_new_package_or_target_changes', scope}
}

const getNonEmptyString = (value: unknown) => {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

const getNumberOrNull = (value: unknown) => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getRecordField = (record: Record<string, unknown>, field: string) => {
  return Object.prototype.hasOwnProperty.call(record, field) ? record[field] : null
}

const getStringField = (record: Record<string, unknown>, field: string) => {
  const value = getRecordField(record, field)

  return typeof value === 'string' ? value : ''
}

const getSqlValueList = (values: readonly string[]) => {
  return values.map(getSqlLiteral).join(', ')
}

const getComparisonKeyParts = (key: ProjectTransferStrongIdentifierComparisonKey) => {
  const separatorIndex = key.indexOf(':')

  return {kind: key.slice(0, separatorIndex), normalizedValue: key.slice(separatorIndex + 1)}
}

const getIdentifierTypeFromKey = (key: string) => {
  return key === 'articleId' ? 'articleId' : key.slice(0, key.indexOf(':'))
}

const getTargetArticleSelectSql = () => {
  return `
    a.id AS targetArticleId,
    a.article_id AS articleId,
    a.article_title AS articleTitle,
    a.article_summary AS articleSummary,
    TO_JSON(a.article_authors) AS articleAuthors,
    a.article_version AS articleVersion,
    a.article_created_at AS articleCreatedAt,
    a.article_updated_at AS articleUpdatedAt,
    a.arxiv_id AS arxivId,
    a.biorxiv_id AS biorxivId,
    a.medrxiv_id AS medrxivId,
    a.doi,
    a.pubmed_id AS pubmedId,
    a.url,
    a.full_text AS fullText,
    a.full_text_html AS fullTextHtml,
    a.full_text_pdf AS fullTextPdf,
    a.full_text_source AS fullTextSource,
    a.full_text_original_format AS fullTextOriginalFormat,
    a.full_text_fetched_at AS fullTextFetchedAt,
    TO_JSON(a.full_text_assets) AS fullTextAssets,
    a.full_text_char_count AS fullTextCharCount,
    a.content_hash AS contentHash,
    a.import_route AS importRoute,
    TO_JSON(a.original_data) AS originalData,
    TO_JSON(a.source_metadata) AS sourceMetadata,
    a.publication_status AS publicationStatus
  `
}

const getImportedArticleInputs = (articles: readonly ProjectTransferArticlePayloadRecord[]) => {
  return articles.map((article): ImportedArticleMatchInput => {
    return {
      article,
      identifierKeys: getProjectTransferStrongIdentifierComparisonKeys(article),
      packageArticleId: getNonEmptyString(getRecordField(article, 'articleId')),
      sourceArticleId: article.sourceArticleId,
    }
  })
}

const getTargetArticlesByPackageArticleId = async ({
  articleIds,
  runner,
}: {
  articleIds: readonly string[]
  runner: ProjectTransferAnalyzeTargetRunner
}) => {
  return articleIds.length === 0
    ? []
    : runner.queryJson<TargetArticleRow>(`
      SELECT ${getTargetArticleSelectSql()}
      FROM app.article a
      WHERE a.article_id IN (${getSqlValueList(articleIds)})
      ORDER BY a.id ASC
    `)
}

const getIdentifierMatchWhereClause = (identifierKeys: readonly ProjectTransferStrongIdentifierComparisonKey[]) => {
  return identifierKeys
    .map(getComparisonKeyParts)
    .map((key) => {
      return `(ai.kind = ${getSqlLiteral(key.kind)} AND ai.normalized_value = ${getSqlLiteral(key.normalizedValue)})`
    })
    .join(' OR ')
}

const getTargetArticlesByIdentifier = async ({
  identifierKeys,
  runner,
}: {
  identifierKeys: readonly ProjectTransferStrongIdentifierComparisonKey[]
  runner: ProjectTransferAnalyzeTargetRunner
}) => {
  return identifierKeys.length === 0
    ? []
    : runner.queryJson<TargetArticleRow & {matchedKey: ProjectTransferStrongIdentifierComparisonKey}>(`
      SELECT
        ${getTargetArticleSelectSql()},
        ai.kind || ':' || ai.normalized_value AS matchedKey
      FROM app.article_identifier ai
      INNER JOIN app.article a ON a.id = ai.article_id
      WHERE ${getIdentifierMatchWhereClause(identifierKeys)}
      ORDER BY a.id ASC, ai.kind ASC, ai.normalized_value ASC
    `)
}

const getCandidateArticleMap = ({
  articleIdRows,
  identifierRows,
  input,
}: {
  articleIdRows: readonly TargetArticleRow[]
  identifierRows: readonly (TargetArticleRow & {matchedKey: ProjectTransferStrongIdentifierComparisonKey})[]
  input: ImportedArticleMatchInput
}) => {
  const candidateRows = [
    ...articleIdRows
      .filter((row) => {
        return input.packageArticleId !== null && row.articleId === input.packageArticleId
      })
      .map((row) => {
        return {
          matchedIdentifier: {identifierType: 'articleId', key: 'articleId', value: input.packageArticleId ?? ''},
          targetArticle: row,
        }
      }),
    ...identifierRows
      .filter((row) => {
        return input.identifierKeys.includes(row.matchedKey)
      })
      .map((row) => {
        return {
          matchedIdentifier: {
            identifierType: getIdentifierTypeFromKey(row.matchedKey),
            key: row.matchedKey,
            value: getComparisonKeyParts(row.matchedKey).normalizedValue,
          },
          targetArticle: row,
        }
      }),
  ]

  return candidateRows.reduce<Map<string, TargetArticleCandidate>>((candidateMap, row) => {
    const existing = candidateMap.get(row.targetArticle.targetArticleId)
    const matchedIdentifiers = existing?.matchedIdentifiers ?? []
    const hasIdentifier = matchedIdentifiers.some((identifier) => {
      return identifier.key === row.matchedIdentifier.key && identifier.value === row.matchedIdentifier.value
    })

    candidateMap.set(row.targetArticle.targetArticleId, {
      matchedIdentifiers: hasIdentifier ? matchedIdentifiers : [...matchedIdentifiers, row.matchedIdentifier],
      targetArticle: row.targetArticle,
      targetArticleId: row.targetArticle.targetArticleId,
    })

    return candidateMap
  }, new Map())
}

const getAmbiguousIdentifierBlockers = ({
  candidates,
  sourceArticleId,
}: {
  candidates: readonly TargetArticleCandidate[]
  sourceArticleId: string
}) => {
  const byIdentifier = candidates
    .flatMap((candidate) => {
      return candidate.matchedIdentifiers.map((identifier) => {
        return {...identifier, targetArticleId: candidate.targetArticleId}
      })
    })
    .reduce<Map<string, Set<string>>>((identifierMap, match) => {
      const key = `${match.key}:${match.value}`
      const targetIds = identifierMap.get(key) ?? new Set<string>()

      targetIds.add(match.targetArticleId)
      identifierMap.set(key, targetIds)

      return identifierMap
    }, new Map())

  return [...byIdentifier.entries()]
    .filter(([_key, targetIds]) => {
      return targetIds.size > 1
    })
    .map(([key, targetIds]) => {
      return getPlanBlocker({
        code: 'article_identifier_ambiguous',
        message: `${sourceArticleId} identifier ${key} matches ${targetIds.size} target articles`,
        scope: `articles.${sourceArticleId}`,
      })
    })
}

const getIdentifierConflictBlocker = ({
  candidates,
  sourceArticleId,
}: {
  candidates: readonly TargetArticleCandidate[]
  sourceArticleId: string
}) => {
  return candidates.length <= 1
    ? []
    : [
        getPlanBlocker({
          code: 'article_identifier_conflict',
          message: `${sourceArticleId} exact identifiers point to different target articles`,
          scope: `articles.${sourceArticleId}`,
        }),
      ]
}

const getInitialArticleMatchPlans = ({
  articleIdRows,
  identifierRows,
  inputs,
}: {
  articleIdRows: readonly TargetArticleRow[]
  identifierRows: readonly (TargetArticleRow & {matchedKey: ProjectTransferStrongIdentifierComparisonKey})[]
  inputs: readonly ImportedArticleMatchInput[]
}) => {
  const blockers = inputs.flatMap((input) => {
    const candidates = [...getCandidateArticleMap({articleIdRows, identifierRows, input}).values()]

    return [
      ...getAmbiguousIdentifierBlockers({candidates, sourceArticleId: input.sourceArticleId}),
      ...getIdentifierConflictBlocker({candidates, sourceArticleId: input.sourceArticleId}),
    ]
  })
  const plans = inputs.map((input): ArticleMatchPlan => {
    const candidates = [...getCandidateArticleMap({articleIdRows, identifierRows, input}).values()]
    const sourceBlockers = blockers.filter((blocker) => {
      return blocker.scope === `articles.${input.sourceArticleId}`
    })
    const selectedTargetArticleId =
      candidates.length === 1 && sourceBlockers.length === 0 ? (candidates[0]?.targetArticleId ?? null) : null
    const action = sourceBlockers.length > 0 ? 'blocked' : selectedTargetArticleId === null ? 'create' : 'reuse'

    return {
      action,
      candidates,
      conflicts: sourceBlockers.map((blocker) => {
        return blocker.code
      }),
      identifierKeys: input.identifierKeys,
      packageArticleId: input.packageArticleId,
      selectedTargetArticleId,
      sourceArticleId: input.sourceArticleId,
    }
  })

  return {blockers, plans}
}

const getCollapseBlockers = (plans: readonly ArticleMatchPlan[]) => {
  const reusedByTarget = plans
    .filter((plan) => {
      return plan.action === 'reuse' && plan.selectedTargetArticleId !== null
    })
    .reduce<Map<string, string[]>>((targetMap, plan) => {
      const targetArticleId = plan.selectedTargetArticleId ?? ''
      const existing = targetMap.get(targetArticleId) ?? []

      targetMap.set(targetArticleId, [...existing, plan.sourceArticleId])

      return targetMap
    }, new Map())

  return [...reusedByTarget.entries()]
    .filter(([_targetArticleId, sourceArticleIds]) => {
      return sourceArticleIds.length > 1
    })
    .flatMap(([targetArticleId, sourceArticleIds]) => {
      return sourceArticleIds.map((sourceArticleId) => {
        return getPlanBlocker({
          code: 'article_target_collapse',
          message: `${sourceArticleId} collapses onto target article ${targetArticleId} with another package article`,
          scope: `articles.${sourceArticleId}`,
        })
      })
    })
}

const applyCollapseBlockers = (
  plans: readonly ArticleMatchPlan[],
  collapseBlockers: readonly ProjectTransferPlanBlocker[],
) => {
  const blockedSourceArticleIds = new Set(
    collapseBlockers.map((blocker) => {
      return blocker.scope.replace('articles.', '')
    }),
  )

  return plans.map((plan): ArticleMatchPlan => {
    return blockedSourceArticleIds.has(plan.sourceArticleId)
      ? {
          ...plan,
          action: 'blocked',
          conflicts: [...plan.conflicts, 'article_target_collapse'],
          selectedTargetArticleId: null,
        }
      : plan
  })
}

const getArticleMatchAnalysis = async ({
  articles,
  runner,
}: {
  articles: readonly ProjectTransferArticlePayloadRecord[]
  runner: ProjectTransferAnalyzeTargetRunner
}) => {
  const inputs = getImportedArticleInputs(articles)
  const packageArticleIds = [
    ...new Set(
      inputs
        .map((input) => {
          return input.packageArticleId
        })
        .filter((value): value is string => {
          return value !== null
        }),
    ),
  ]
  const identifierKeys = [
    ...new Set(
      inputs.flatMap((input) => {
        return input.identifierKeys
      }),
    ),
  ]
  const [articleIdRows, identifierRows] = await Promise.all([
    getTargetArticlesByPackageArticleId({articleIds: packageArticleIds, runner}),
    getTargetArticlesByIdentifier({identifierKeys, runner}),
  ])
  const initial = getInitialArticleMatchPlans({articleIdRows, identifierRows, inputs})
  const collapseBlockers = getCollapseBlockers(initial.plans)
  const plans = applyCollapseBlockers(initial.plans, collapseBlockers)

  return {blockers: [...initial.blockers, ...collapseBlockers], plans}
}

const getTargetArticleById = (plans: readonly ArticleMatchPlan[]) => {
  return plans.reduce<Map<string, TargetArticleRow>>((articleMap, plan) => {
    const candidate = plan.candidates.find((entry) => {
      return entry.targetArticleId === plan.selectedTargetArticleId
    })

    return candidate ? articleMap.set(candidate.targetArticleId, candidate.targetArticle) : articleMap
  }, new Map())
}

const getResolvedArticleIdBySource = (plans: readonly ArticleMatchPlan[]) => {
  return plans.reduce<Record<string, string | null>>((articleMap, plan) => {
    return {...articleMap, [plan.sourceArticleId]: plan.selectedTargetArticleId}
  }, {})
}

const getSelectedTargetArticleBySource = (plans: readonly ArticleMatchPlan[]) => {
  return plans.reduce<Record<string, TargetArticleRow | null>>((articleMap, plan) => {
    const targetArticle =
      plan.selectedTargetArticleId === null
        ? null
        : (plan.candidates.find((candidate) => {
            return candidate.targetArticleId === plan.selectedTargetArticleId
          })?.targetArticle ?? null)

    return {...articleMap, [plan.sourceArticleId]: targetArticle}
  }, {})
}

const getImportedArticleBySource = (articles: readonly ProjectTransferArticlePayloadRecord[]) => {
  return articles.reduce<Record<string, ProjectTransferArticlePayloadRecord>>((articleMap, article) => {
    return {...articleMap, [article.sourceArticleId]: article}
  }, {})
}

const getRuntimeAssetPathsFromString = (value: string) => {
  return value.match(articleRuntimeAssetPathPattern) ?? []
}

const getRuntimeAssetPathsFromValue = (value: unknown): string[] => {
  return typeof value === 'string'
    ? getRuntimeAssetPathsFromString(value)
    : Array.isArray(value)
      ? value.flatMap(getRuntimeAssetPathsFromValue)
      : isRecord(value)
        ? Object.values(value).flatMap(getRuntimeAssetPathsFromValue)
        : []
}

const getArticleFieldAssetPaths = (article: ProjectTransferArticlePayloadRecord) => {
  return articleFillFields.reduce<Record<string, string[]>>((assetMap, field) => {
    return {...assetMap, [field]: getRuntimeAssetPathsFromValue(getRecordField(article, field))}
  }, {})
}

const hasIncomingFillValue = (value: unknown) => {
  return typeof value === 'string'
    ? value.trim() !== ''
    : Array.isArray(value)
      ? value.length > 0
      : isRecord(value)
        ? Object.keys(value).length > 0
        : value !== null && value !== undefined
}

const isMissingTargetValue = (value: unknown) => {
  return typeof value === 'string' ? value.trim() === '' : value === null || value === undefined
}

const getArticleFieldFills = ({
  article,
  assetPathsByField,
  targetArticle,
}: {
  article: ProjectTransferArticlePayloadRecord
  assetPathsByField: Record<string, string[]>
  targetArticle: TargetArticleRow
}) => {
  return articleFillFields
    .map((field): ArticleFieldFill | null => {
      const value = getRecordField(article, field)
      const targetValue = targetArticle[field]
      const assetPaths = assetPathsByField[field] ?? []

      return hasIncomingFillValue(value) && isMissingTargetValue(targetValue)
        ? {assetDriven: assetPaths.length > 0, assetPaths, field, value}
        : null
    })
    .filter((fill): fill is ArticleFieldFill => {
      return fill !== null
    })
}

const getReferencingProjects = async ({
  runner,
  targetArticleIds,
}: {
  runner: ProjectTransferAnalyzeTargetRunner
  targetArticleIds: readonly string[]
}) => {
  return targetArticleIds.length === 0
    ? []
    : runner.queryJson<ReferencingProjectRow>(`
      WITH referenced_article AS (
        SELECT pa.article_id AS targetArticleId, pa.project_id AS projectId
        FROM app.project_article pa
        WHERE pa.article_id IN (${getSqlValueList(targetArticleIds)})
        UNION
        SELECT air.article_id AS targetArticleId, pir.project_id AS projectId
        FROM app.article_import_route air
        INNER JOIN app.project_import_route pir ON pir.import_route_id = air.import_route_id
        WHERE air.article_id IN (${getSqlValueList(targetArticleIds)})
      )
      SELECT DISTINCT
        referenced_article.targetArticleId,
        p.id AS projectId,
        p.archived,
        p.date_from AS dateFrom,
        p.date_to AS dateTo
      FROM referenced_article
      INNER JOIN app.project p ON p.id = referenced_article.projectId
      ORDER BY referenced_article.targetArticleId ASC, p.id ASC
    `)
}

const isDateWithinProjectBounds = ({
  articleCreatedAt,
  dateFrom,
  dateTo,
}: {
  articleCreatedAt: unknown
  dateFrom: unknown
  dateTo: unknown
}) => {
  const date = getDateValue(articleCreatedAt)
  const from = getDateValue(dateFrom)
  const to = getDateValue(dateTo)

  return (
    (from === null && to === null) || (date !== null && (from === null || date >= from) && (to === null || date <= to))
  )
}

const getImportedProjectDateScopeBlocker = ({
  articleCreatedAt,
  dateFrom,
  dateTo,
  sourceArticleId,
}: {
  articleCreatedAt: unknown
  dateFrom: unknown
  dateTo: unknown
  sourceArticleId: string
}) => {
  return isDateWithinProjectBounds({articleCreatedAt, dateFrom, dateTo})
    ? []
    : [
        getPlanBlocker({
          code: 'reused_article_project_date_scope_conflict',
          message: `${sourceArticleId} target article date is outside the imported project date bounds`,
          scope: `articles.${sourceArticleId}.articleCreatedAt`,
        }),
      ]
}

const getArticleCreatedAtFillExpansionBlockers = ({
  fieldFills,
  referencingProjects,
  sourceArticleId,
  targetArticle,
}: {
  fieldFills: readonly ArticleFieldFill[]
  referencingProjects: readonly ReferencingProjectRow[]
  sourceArticleId: string
  targetArticle: TargetArticleRow
}) => {
  const createdAtFill = fieldFills.find((fill) => {
    return fill.field === 'articleCreatedAt'
  })

  return createdAtFill === undefined
    ? []
    : referencingProjects
        .filter((project) => {
          const before = isDateWithinProjectBounds({
            articleCreatedAt: targetArticle.articleCreatedAt,
            dateFrom: project.dateFrom,
            dateTo: project.dateTo,
          })
          const after = isDateWithinProjectBounds({
            articleCreatedAt: createdAtFill.value,
            dateFrom: project.dateFrom,
            dateTo: project.dateTo,
          })

          return !before && after
        })
        .map((project) => {
          return getPlanBlocker({
            code: 'reused_article_date_expansion_blocked',
            message: `${sourceArticleId} articleCreatedAt fill would expand project ${project.projectId}`,
            scope: `articles.${sourceArticleId}.articleCreatedAt`,
          })
        })
}

const getArticleUpdatePlan = async ({
  articleMatches,
  articles,
  assetManifestEntries,
  importedProject,
  runner,
}: {
  articleMatches: readonly ArticleMatchPlan[]
  articles: readonly ProjectTransferArticlePayloadRecord[]
  assetManifestEntries: readonly ProjectTransferAssetManifestEntry[]
  importedProject: ProjectTransferPayloadByKey['project'] | null
  runner: ProjectTransferAnalyzeTargetRunner
}) => {
  const targetArticleById = getTargetArticleById(articleMatches)
  const reusedMatches = articleMatches.filter((match) => {
    return match.action === 'reuse' && match.selectedTargetArticleId !== null
  })
  const referencingProjects = await getReferencingProjects({
    runner,
    targetArticleIds: reusedMatches.map((match) => {
      return match.selectedTargetArticleId ?? ''
    }),
  })
  const articlesBySource = getImportedArticleBySource(articles)
  const assetManifestPaths = new Set(
    assetManifestEntries.map((entry) => {
      return entry.packagePath
    }),
  )
  const importedDateFrom = getRecordField(importedProject ?? {}, 'dateFrom')
  const importedDateTo = getRecordField(importedProject ?? {}, 'dateTo')
  const updatePlan = reusedMatches.map((match): ArticleUpdatePlan => {
    const targetArticle = targetArticleById.get(match.selectedTargetArticleId ?? '') as TargetArticleRow
    const article = articlesBySource[match.sourceArticleId] as ProjectTransferArticlePayloadRecord
    const assetPathsByField = getArticleFieldAssetPaths(article)
    const fieldFills = getArticleFieldFills({article, assetPathsByField, targetArticle}).filter((fill) => {
      return fill.assetPaths.every((assetPath) => {
        return assetManifestPaths.has(assetPath)
      })
    })
    const projectReferences = referencingProjects.filter((project) => {
      return project.targetArticleId === targetArticle.targetArticleId
    })
    const dateExpansionBlockers = getArticleCreatedAtFillExpansionBlockers({
      fieldFills,
      referencingProjects: projectReferences,
      sourceArticleId: match.sourceArticleId,
      targetArticle,
    })
    const activeDirtiedProjectIds =
      fieldFills.length === 0
        ? []
        : projectReferences
            .filter((project) => {
              return !project.archived
            })
            .map((project) => {
              return project.projectId
            })

    return {
      activeDirtiedProjectIds,
      archivedReferencingProjectCount: projectReferences.filter((project) => {
        return project.archived
      }).length,
      dateExpansionBlockers,
      fieldFills,
      sourceArticleId: match.sourceArticleId,
      targetArticleId: targetArticle.targetArticleId,
    }
  })
  const importedProjectDateBlockers =
    importedDateFrom === null && importedDateTo === null
      ? []
      : reusedMatches.flatMap((match) => {
          const targetArticle = targetArticleById.get(match.selectedTargetArticleId ?? '') as TargetArticleRow
          const article = articlesBySource[match.sourceArticleId] as ProjectTransferArticlePayloadRecord
          const effectiveArticleCreatedAt = isMissingTargetValue(targetArticle.articleCreatedAt)
            ? getRecordField(article, 'articleCreatedAt')
            : targetArticle.articleCreatedAt

          return getImportedProjectDateScopeBlocker({
            articleCreatedAt: effectiveArticleCreatedAt,
            dateFrom: importedDateFrom,
            dateTo: importedDateTo,
            sourceArticleId: match.sourceArticleId,
          })
        })

  return {
    blockers: [
      ...updatePlan.flatMap((plan) => {
        return plan.dateExpansionBlockers
      }),
      ...importedProjectDateBlockers,
    ],
    updatePlan,
  }
}

const getPromptRowsByContentHash = async ({
  contentHashes,
  runner,
}: {
  contentHashes: readonly string[]
  runner: ProjectTransferAnalyzeTargetRunner
}) => {
  return contentHashes.length === 0
    ? []
    : runner.queryJson<TargetPromptRow>(`
      SELECT
        id AS targetPromptId,
        content_hash AS contentHash,
        archived
      FROM app.prompt
      WHERE content_hash IN (${getSqlValueList(contentHashes)})
      ORDER BY id ASC
    `)
}

const getPromptPlan = async ({
  projectPrompts,
  prompts,
  runner,
}: {
  projectPrompts: readonly ProjectTransferPayloadRecord[]
  prompts: readonly ProjectTransferPayloadRecord[]
  runner: ProjectTransferAnalyzeTargetRunner
}) => {
  const promptInputs = prompts.map((prompt) => {
    const computedContentHash = computePromptContentHash(
      getStringField(prompt, 'originalText'),
      getNonEmptyString(getRecordField(prompt, 'transformedText')),
      getNonEmptyString(getRecordField(prompt, 'promptHeading')),
      getNonEmptyString(getRecordField(prompt, 'type')),
    )

    return {
      computedContentHash,
      packageContentHash: getNonEmptyString(getRecordField(prompt, 'contentHash')),
      prompt,
      sourcePromptId: getStringField(prompt, 'sourcePromptId'),
    }
  })
  const promptRows = await getPromptRowsByContentHash({
    contentHashes: [
      ...new Set(
        promptInputs.map((prompt) => {
          return prompt.computedContentHash
        }),
      ),
    ],
    runner,
  })
  const targetPromptByHash = promptRows.reduce<Record<string, TargetPromptRow>>((promptMap, prompt) => {
    return prompt.contentHash ? {...promptMap, [prompt.contentHash]: prompt} : promptMap
  }, {})
  const promptPlan = promptInputs.map((prompt): PromptPlanEntry => {
    const targetPrompt = targetPromptByHash[prompt.computedContentHash] ?? null

    return {
      action: targetPrompt ? 'reuse' : 'create',
      computedContentHash: prompt.computedContentHash,
      packageContentHash: prompt.packageContentHash,
      sourcePromptId: prompt.sourcePromptId,
      targetPromptId: targetPrompt?.targetPromptId ?? null,
    }
  })
  const promptPlanBySource = promptPlan.reduce<Record<string, PromptPlanEntry>>((promptMap, prompt) => {
    return {...promptMap, [prompt.sourcePromptId]: prompt}
  }, {})
  const projectPromptPlan = projectPrompts.map((projectPrompt): ProjectPromptPlanEntry => {
    const sourcePromptId = getStringField(projectPrompt, 'sourcePromptId')
    const prompt = promptPlanBySource[sourcePromptId]
    const targetPromptId = prompt?.targetPromptId ?? (prompt ? `new:${prompt.computedContentHash}` : null)

    return {
      enabled: getRecordField(projectPrompt, 'enabled') === true,
      metadata: {
        archived: getRecordField(projectPrompt, 'archived') === true,
        criteriaDisposition: getRecordField(projectPrompt, 'criteriaDisposition'),
        criteriaSectionKey: getRecordField(projectPrompt, 'criteriaSectionKey'),
        criteriaSectionLabel: getRecordField(projectPrompt, 'criteriaSectionLabel'),
      },
      order: getNumberOrNull(getRecordField(projectPrompt, 'order')),
      sourceProjectPromptId: getStringField(projectPrompt, 'sourceProjectPromptId'),
      sourcePromptId,
      targetPromptId,
    }
  })
  const collisions = [
    ...projectPromptPlan
      .reduce<Map<string, ProjectPromptPlanEntry[]>>((planMap, projectPrompt) => {
        const targetPromptId = projectPrompt.targetPromptId ?? ''
        const existing = planMap.get(targetPromptId) ?? []

        planMap.set(targetPromptId, [...existing, projectPrompt])

        return planMap
      }, new Map())
      .values(),
  ].filter((entries) => {
    const metadataValues = new Set(
      entries.map((entry) => {
        return JSON.stringify({enabled: entry.enabled, metadata: entry.metadata, order: entry.order})
      }),
    )

    return entries.length > 1 && metadataValues.size > 1
  })
  const blockers = collisions.flatMap((entries) => {
    return entries.map((entry) => {
      return getPlanBlocker({
        code: 'project_prompt_canonical_remap_collision',
        message: `${entry.sourceProjectPromptId} remaps to a prompt used by conflicting project-prompt metadata`,
        scope: `projectPrompts.${entry.sourceProjectPromptId}`,
      })
    })
  })
  const warnings = promptInputs
    .filter((prompt) => {
      return prompt.packageContentHash !== null && prompt.packageContentHash !== prompt.computedContentHash
    })
    .map((prompt): ProjectTransferPackageWarning => {
      return {
        action: 'planned',
        code: 'promptContentHashRecomputed',
        details: {
          computedContentHash: prompt.computedContentHash,
          packageContentHash: prompt.packageContentHash,
          sourcePromptId: prompt.sourcePromptId,
        },
        message: `${prompt.sourcePromptId} content hash was recomputed from package prompt fields`,
        scope: `prompts.${prompt.sourcePromptId}`,
        severity: 'warning',
      }
    })

  return {blockers, projectPromptPlan, promptPlan, warnings}
}

const getTargetImportRoutes = async ({
  routeValues,
  runner,
}: {
  routeValues: readonly string[]
  runner: ProjectTransferAnalyzeTargetRunner
}) => {
  return routeValues.length === 0
    ? []
    : runner.queryJson<TargetImportRouteRow>(`
      SELECT
        id AS targetImportRouteId,
        route,
        active
      FROM app.import_route
      WHERE route IN (${getSqlValueList(routeValues)})
      ORDER BY route ASC, active DESC, id ASC
    `)
}

const getRouteArticles = async ({
  runner,
  targetImportRouteIds,
}: {
  runner: ProjectTransferAnalyzeTargetRunner
  targetImportRouteIds: readonly string[]
}) => {
  return targetImportRouteIds.length === 0
    ? []
    : runner.queryJson<RouteArticleRow>(`
      SELECT
        air.import_route_id AS targetImportRouteId,
        air.article_id AS targetArticleId,
        a.article_created_at AS articleCreatedAt
      FROM app.article_import_route air
      INNER JOIN app.article a ON a.id = air.article_id
      WHERE air.import_route_id IN (${getSqlValueList(targetImportRouteIds)})
      ORDER BY air.import_route_id ASC, air.article_id ASC
    `)
}

const getProjectRouteReferences = async ({
  runner,
  targetImportRouteIds,
}: {
  runner: ProjectTransferAnalyzeTargetRunner
  targetImportRouteIds: readonly string[]
}) => {
  return targetImportRouteIds.length === 0
    ? []
    : runner.queryJson<ProjectRouteReferenceRow>(`
      SELECT
        pir.import_route_id AS targetImportRouteId,
        pir.project_id AS projectId,
        p.archived,
        p.date_from AS dateFrom,
        p.date_to AS dateTo
      FROM app.project_import_route pir
      INNER JOIN app.project p ON p.id = pir.project_id
      WHERE pir.import_route_id IN (${getSqlValueList(targetImportRouteIds)})
      ORDER BY pir.import_route_id ASC, pir.project_id ASC
    `)
}

const getProjectArticleReferences = async ({
  projectIds,
  runner,
  targetArticleIds,
}: {
  projectIds: readonly string[]
  runner: ProjectTransferAnalyzeTargetRunner
  targetArticleIds: readonly string[]
}) => {
  return projectIds.length === 0 || targetArticleIds.length === 0
    ? []
    : runner.queryJson<ProjectArticleReferenceRow>(`
      SELECT
        project_id AS projectId,
        article_id AS targetArticleId
      FROM app.project_article
      WHERE project_id IN (${getSqlValueList(projectIds)})
        AND article_id IN (${getSqlValueList(targetArticleIds)})
      ORDER BY project_id ASC, article_id ASC
    `)
}

const getActiveRouteBySource = ({
  importRoutes,
  targetRoutes,
}: {
  importRoutes: readonly ProjectTransferPayloadRecord[]
  targetRoutes: readonly TargetImportRouteRow[]
}) => {
  const activeTargetByRoute = targetRoutes
    .filter((route) => {
      return route.active
    })
    .reduce<Record<string, TargetImportRouteRow>>((routeMap, route) => {
      return {...routeMap, [route.route]: route}
    }, {})

  return importRoutes.reduce<Record<string, TargetImportRouteRow | null>>((routeMap, route) => {
    const sourceImportRouteId = getStringField(route, 'sourceImportRouteId')
    const routeValue = getStringField(route, 'route')

    return {...routeMap, [sourceImportRouteId]: activeTargetByRoute[routeValue] ?? null}
  }, {})
}

const getRouteWarnings = ({
  importRoutes,
  targetRoutes,
}: {
  importRoutes: readonly ProjectTransferPayloadRecord[]
  targetRoutes: readonly TargetImportRouteRow[]
}) => {
  return importRoutes.flatMap((route): ProjectTransferPackageWarning[] => {
    const routeValue = getStringField(route, 'route')
    const sourceImportRouteId = getStringField(route, 'sourceImportRouteId')
    const matches = targetRoutes.filter((targetRoute) => {
      return targetRoute.route === routeValue
    })
    const activeMatch = matches.find((targetRoute) => {
      return targetRoute.active
    })

    return activeMatch
      ? []
      : [
          {
            action: 'omitted',
            code: matches.length === 0 ? 'targetImportRouteMissing' : 'targetImportRouteInactive',
            details: {route: routeValue, sourceImportRouteId},
            message: `${routeValue} target import route is missing or inactive`,
            scope: `importRoutes.${sourceImportRouteId}`,
            severity: 'warning',
          },
        ]
  })
}

const getExportedTargetArticleSet = (articleMatches: readonly ArticleMatchPlan[]) => {
  return new Set(
    articleMatches
      .map((match) => {
        return match.selectedTargetArticleId
      })
      .filter((targetArticleId): targetArticleId is string => {
        return targetArticleId !== null
      }),
  )
}

const getProjectRoutePlan = ({
  activeRouteBySource,
  articleMatches,
  importedProject,
  projectImportRoutes,
  routeArticles,
}: {
  activeRouteBySource: Record<string, TargetImportRouteRow | null>
  articleMatches: readonly ArticleMatchPlan[]
  importedProject: ProjectTransferPayloadByKey['project'] | null
  projectImportRoutes: readonly ProjectTransferPayloadRecord[]
  routeArticles: readonly RouteArticleRow[]
}) => {
  const exportedTargetArticleIds = getExportedTargetArticleSet(articleMatches)
  const dateFrom = getRecordField(importedProject ?? {}, 'dateFrom')
  const dateTo = getRecordField(importedProject ?? {}, 'dateTo')

  return projectImportRoutes.map((projectRoute): ProjectRoutePlanEntry => {
    const sourceImportRouteId = getStringField(projectRoute, 'sourceImportRouteId')
    const sourceProjectImportRouteId = getStringField(projectRoute, 'sourceProjectImportRouteId')
    const targetRoute = activeRouteBySource[sourceImportRouteId] ?? null
    const targetRouteArticles = routeArticles.filter((routeArticle) => {
      return routeArticle.targetImportRouteId === targetRoute?.targetImportRouteId
    })
    const outsideExportedArticleCount = targetRouteArticles.filter((routeArticle) => {
      return !exportedTargetArticleIds.has(routeArticle.targetArticleId)
    }).length
    const dateBoundedRouteArticles = targetRouteArticles.filter((routeArticle) => {
      return isDateWithinProjectBounds({articleCreatedAt: routeArticle.articleCreatedAt, dateFrom, dateTo})
    })
    const dateBoundedOutsideExportedArticleCount = dateBoundedRouteArticles.filter((routeArticle) => {
      return !exportedTargetArticleIds.has(routeArticle.targetArticleId)
    }).length

    return {
      action: targetRoute !== null && dateBoundedOutsideExportedArticleCount === 0 ? 'link' : 'omit',
      dateBoundedOutsideExportedArticleCount,
      dateBoundedRouteArticleCount: dateBoundedRouteArticles.length,
      outsideExportedArticleCount,
      sourceImportRouteId,
      sourceProjectImportRouteId,
      targetImportRouteId: targetRoute?.targetImportRouteId ?? null,
    }
  })
}

const getProjectArticleSourceSet = (projectArticles: readonly ProjectTransferPayloadRecord[]) => {
  return new Set(
    projectArticles.map((projectArticle) => {
      return getStringField(projectArticle, 'sourceArticleId')
    }),
  )
}

const getArticleRoutePlan = ({
  activeRouteBySource,
  articleImportRoutes,
  articles,
  articleMatches,
  projectArticleReferences,
  projectArticles,
  projectRouteReferences,
  routeArticles,
}: {
  activeRouteBySource: Record<string, TargetImportRouteRow | null>
  articleImportRoutes: readonly ProjectTransferPayloadRecord[]
  articles: readonly ProjectTransferArticlePayloadRecord[]
  articleMatches: readonly ArticleMatchPlan[]
  projectArticleReferences: readonly ProjectArticleReferenceRow[]
  projectArticles: readonly ProjectTransferPayloadRecord[]
  projectRouteReferences: readonly ProjectRouteReferenceRow[]
  routeArticles: readonly RouteArticleRow[]
}) => {
  const targetArticleBySource = getResolvedArticleIdBySource(articleMatches)
  const targetArticleRecordBySource = getSelectedTargetArticleBySource(articleMatches)
  const importedArticleBySource = getImportedArticleBySource(articles)
  const projectArticleSourceSet = getProjectArticleSourceSet(projectArticles)
  const routeArticleSet = new Set(
    routeArticles.map((routeArticle) => {
      return `${routeArticle.targetImportRouteId}:${routeArticle.targetArticleId}`
    }),
  )
  const projectArticleSet = new Set(
    projectArticleReferences.map((projectArticle) => {
      return `${projectArticle.projectId}:${projectArticle.targetArticleId}`
    }),
  )

  return articleImportRoutes.map((articleRoute): ArticleRoutePlanEntry => {
    const sourceArticleId = getStringField(articleRoute, 'sourceArticleId')
    const sourceImportRouteId = getStringField(articleRoute, 'sourceImportRouteId')
    const sourceArticleImportRouteId = getStringField(articleRoute, 'sourceArticleImportRouteId')
    const targetArticleId = targetArticleBySource[sourceArticleId] ?? null
    const targetArticle = targetArticleRecordBySource[sourceArticleId] ?? null
    const importedArticle = importedArticleBySource[sourceArticleId] ?? null
    const articleCreatedAt =
      targetArticle?.articleCreatedAt ?? getRecordField(importedArticle ?? {}, 'articleCreatedAt')
    const targetRoute = activeRouteBySource[sourceImportRouteId] ?? null
    const existingRouteArticle =
      targetArticleId !== null && targetRoute !== null
        ? routeArticleSet.has(`${targetRoute.targetImportRouteId}:${targetArticleId}`)
        : false
    const linkedProjects = projectRouteReferences.filter((projectRoute) => {
      return (
        projectRoute.targetImportRouteId === targetRoute?.targetImportRouteId
        && !projectRoute.archived
        && isDateWithinProjectBounds({articleCreatedAt, dateFrom: projectRoute.dateFrom, dateTo: projectRoute.dateTo})
      )
    })
    const unsafeProjectIds =
      existingRouteArticle || targetRoute === null
        ? []
        : linkedProjects
            .filter((projectRoute) => {
              return targetArticleId === null || !projectArticleSet.has(`${projectRoute.projectId}:${targetArticleId}`)
            })
            .map((projectRoute) => {
              return projectRoute.projectId
            })
    const action =
      targetRoute === null || unsafeProjectIds.length > 0 ? 'omit' : existingRouteArticle ? 'exists' : 'write'

    return {
      action,
      sourceArticleId,
      sourceArticleImportRouteId,
      sourceImportRouteId,
      snapshotProjectArticleLink: action === 'omit' && projectArticleSourceSet.has(sourceArticleId),
      targetArticleId,
      targetImportRouteId: targetRoute?.targetImportRouteId ?? null,
      unsafeProjectIds,
    }
  })
}

const getRoutePlan = async ({
  articleImportRoutes,
  articleMatches,
  articles,
  importRoutes,
  importedProject,
  projectArticles,
  projectImportRoutes,
  runner,
}: {
  articleImportRoutes: readonly ProjectTransferPayloadRecord[]
  articleMatches: readonly ArticleMatchPlan[]
  articles: readonly ProjectTransferArticlePayloadRecord[]
  importRoutes: readonly ProjectTransferPayloadRecord[]
  importedProject: ProjectTransferPayloadByKey['project'] | null
  projectArticles: readonly ProjectTransferPayloadRecord[]
  projectImportRoutes: readonly ProjectTransferPayloadRecord[]
  runner: ProjectTransferAnalyzeTargetRunner
}) => {
  const routeValues = [
    ...new Set(
      importRoutes.map((route) => {
        return getStringField(route, 'route')
      }),
    ),
  ]
  const targetRoutes = await getTargetImportRoutes({routeValues, runner})
  const activeRouteBySource = getActiveRouteBySource({importRoutes, targetRoutes})
  const targetImportRouteIds = [
    ...new Set(
      Object.values(activeRouteBySource)
        .map((route) => {
          return route?.targetImportRouteId ?? null
        })
        .filter((routeId): routeId is string => {
          return routeId !== null
        }),
    ),
  ]
  const routeArticles = await getRouteArticles({runner, targetImportRouteIds})
  const projectRouteReferences = await getProjectRouteReferences({runner, targetImportRouteIds})
  const targetArticleIds = [
    ...new Set(
      articleMatches
        .map((match) => {
          return match.selectedTargetArticleId
        })
        .filter((targetArticleId): targetArticleId is string => {
          return targetArticleId !== null
        }),
    ),
  ]
  const projectArticleReferences = await getProjectArticleReferences({
    projectIds: [
      ...new Set(
        projectRouteReferences.map((projectRoute) => {
          return projectRoute.projectId
        }),
      ),
    ],
    runner,
    targetArticleIds,
  })
  const projectRoutePlan = getProjectRoutePlan({
    activeRouteBySource,
    articleMatches,
    importedProject,
    projectImportRoutes,
    routeArticles,
  })
  const articleRoutePlan = getArticleRoutePlan({
    activeRouteBySource,
    articleImportRoutes,
    articles,
    articleMatches,
    projectArticleReferences,
    projectArticles,
    projectRouteReferences,
    routeArticles,
  })

  return {articleRoutePlan, projectRoutePlan, warnings: getRouteWarnings({importRoutes, targetRoutes})}
}

const getUnsafeArticleFieldStringBlockers = ({
  path,
  sourceArticleId,
  value,
}: {
  path: string
  sourceArticleId: string
  value: string
}) => {
  return [
    ...(value.includes('/api/runtime-asset')
      ? [
          getPlanBlocker({
            code: 'article_source_runtime_asset_url',
            message: `${sourceArticleId} contains a source runtime-asset URL`,
            scope: path,
          }),
        ]
      : []),
    ...(value.includes('tmp/project-transfer')
      ? [
          getPlanBlocker({
            code: 'article_temp_path_reference',
            message: `${sourceArticleId} contains a temporary project-transfer path`,
            scope: path,
          }),
        ]
      : []),
    ...(/^\/(?!\/)/.test(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('file://')
      ? [
          getPlanBlocker({
            code: 'article_absolute_path_reference',
            message: `${sourceArticleId} contains an absolute local path`,
            scope: path,
          }),
        ]
      : []),
  ]
}

const getArticleAssetReferenceBlockers = ({
  assetManifestPaths,
  path,
  sourceArticleId,
  value,
}: {
  assetManifestPaths: Set<string>
  path: string
  sourceArticleId: string
  value: string
}) => {
  return getRuntimeAssetPathsFromString(value)
    .filter((assetPath) => {
      const validation = validateProjectTransferRuntimeAssetPath(assetPath)

      return !validation.ok || !assetManifestPaths.has(assetPath)
    })
    .map((assetPath) => {
      return getPlanBlocker({
        code: 'article_asset_reference_undeclared',
        message: `${sourceArticleId} references undeclared asset ${assetPath}`,
        scope: path,
      })
    })
}

const getArticleFieldReferenceBlockers = ({
  assetManifestPaths,
  path,
  sourceArticleId,
  value,
}: {
  assetManifestPaths: Set<string>
  path: string
  sourceArticleId: string
  value: unknown
}): ProjectTransferPlanBlocker[] => {
  return typeof value === 'string'
    ? [
        ...getUnsafeArticleFieldStringBlockers({path, sourceArticleId, value}),
        ...getArticleAssetReferenceBlockers({assetManifestPaths, path, sourceArticleId, value}),
      ]
    : Array.isArray(value)
      ? value.flatMap((entry, index) => {
          return getArticleFieldReferenceBlockers({
            assetManifestPaths,
            path: `${path}[${index}]`,
            sourceArticleId,
            value: entry,
          })
        })
      : isRecord(value)
        ? Object.entries(value).flatMap(([field, entry]) => {
            return getArticleFieldReferenceBlockers({
              assetManifestPaths,
              path: `${path}.${field}`,
              sourceArticleId,
              value: entry,
            })
          })
        : []
}

const getArticleReferenceBlockers = ({
  articles,
  assetManifestEntries,
}: {
  articles: readonly ProjectTransferArticlePayloadRecord[]
  assetManifestEntries: readonly ProjectTransferAssetManifestEntry[]
}) => {
  const assetManifestPaths = new Set(
    assetManifestEntries.map((entry) => {
      return entry.packagePath
    }),
  )

  return articles.flatMap((article) => {
    return Object.entries(article)
      .filter(([field]) => {
        return !articleReferenceScanExcludedFields.has(field)
      })
      .flatMap(([field, value]) => {
        return getArticleFieldReferenceBlockers({
          assetManifestPaths,
          path: `articles.${article.sourceArticleId}.${field}`,
          sourceArticleId: article.sourceArticleId,
          value,
        })
      })
  })
}

const getAssetPromotionPlan = ({
  articleMatches,
  articleUpdatePlan,
  articles,
  assetManifestEntries,
}: {
  articleMatches: readonly ArticleMatchPlan[]
  articleUpdatePlan: readonly ArticleUpdatePlan[]
  articles: readonly ProjectTransferArticlePayloadRecord[]
  assetManifestEntries: readonly ProjectTransferAssetManifestEntry[]
}) => {
  const assetEntryByPath = assetManifestEntries.reduce<Record<string, ProjectTransferAssetManifestEntry>>(
    (entryMap, entry) => {
      return {...entryMap, [entry.packagePath]: entry}
    },
    {},
  )
  const reusedPromotionRows = articleUpdatePlan.flatMap((plan) => {
    return plan.fieldFills.flatMap((fill) => {
      return fill.assetPaths.map((assetPath) => {
        return {
          assetPath,
          field: fill.field,
          sourceArticleId: plan.sourceArticleId,
          targetArticleId: plan.targetArticleId,
        }
      })
    })
  })
  const articlesBySource = getImportedArticleBySource(articles)
  const newPromotionRows = articleMatches
    .filter((match) => {
      return match.action === 'create'
    })
    .flatMap((match) => {
      const article = articlesBySource[match.sourceArticleId] as ProjectTransferArticlePayloadRecord | undefined
      const assetPathsByField = article ? getArticleFieldAssetPaths(article) : {}

      return Object.entries(assetPathsByField).flatMap(([field, assetPaths]) => {
        return assetPaths.map((assetPath) => {
          return {
            assetPath,
            field,
            sourceArticleId: match.sourceArticleId,
            targetArticleId: `new:${match.sourceArticleId}`,
          }
        })
      })
    })
  const promotionRows = [...reusedPromotionRows, ...newPromotionRows].filter((row) => {
    return assetEntryByPath[row.assetPath] !== undefined
  })

  return [
    ...promotionRows
      .reduce<Map<string, typeof promotionRows>>((promotionMap, row) => {
        const existing = promotionMap.get(row.assetPath) ?? []

        promotionMap.set(row.assetPath, [...existing, row])

        return promotionMap
      }, new Map())
      .entries(),
  ].map(([assetPath, rows]): AssetPromotionPlanEntry => {
    const entry = assetEntryByPath[assetPath] as ProjectTransferAssetManifestEntry

    return {
      byteLength: entry.byteLength,
      checksumSha256: entry.checksumSha256,
      ...(entry.contentType === undefined ? {} : {contentType: entry.contentType}),
      fields: [
        ...new Set(
          rows.map((row) => {
            return row.field
          }),
        ),
      ].sort(),
      packagePath: assetPath,
      sourceArticleIds: [
        ...new Set(
          rows.map((row) => {
            return row.sourceArticleId
          }),
        ),
      ].sort(),
      targetArticleIds: [
        ...new Set(
          rows.map((row) => {
            return row.targetArticleId
          }),
        ),
      ].sort(),
    }
  })
}

const getTargetOverlapCounts = ({
  articleMatches,
  articleRoutePlan,
  articleUpdatePlan,
  assetPromotionPlan,
  duplicateImportMatchCount,
  projectRoutePlan,
}: {
  articleMatches: readonly ArticleMatchPlan[]
  articleRoutePlan: readonly ArticleRoutePlanEntry[]
  articleUpdatePlan: readonly ArticleUpdatePlan[]
  assetPromotionPlan: readonly AssetPromotionPlanEntry[]
  duplicateImportMatchCount: number
  projectRoutePlan: readonly ProjectRoutePlanEntry[]
}) => {
  const counts = getProjectTransferInitialOverlapCounts()
  const activeDirtiedProjectIds = new Set(
    articleUpdatePlan.flatMap((plan) => {
      return plan.activeDirtiedProjectIds
    }),
  )
  const reusedAssetPaths = new Set(
    articleUpdatePlan.flatMap((plan) => {
      return plan.fieldFills.flatMap((fill) => {
        return fill.assetPaths
      })
    }),
  )

  return {
    ...counts,
    dirtiedExistingProjectCount: activeDirtiedProjectIds.size,
    duplicateImportMatchCount,
    newArticleCount: articleMatches.filter((match) => {
      return match.action === 'create'
    }).length,
    omittedArticleRouteLinkCount: articleRoutePlan.filter((entry) => {
      return entry.action === 'omit'
    }).length,
    omittedRouteLinkCount: projectRoutePlan.filter((entry) => {
      return entry.action === 'omit'
    }).length,
    reusedArticleAssetPromotionCount: assetPromotionPlan.filter((entry) => {
      return reusedAssetPaths.has(entry.packagePath)
    }).length,
    reusedArticleCount: articleMatches.filter((match) => {
      return match.action === 'reuse'
    }).length,
    reusedArticleFieldFillCount: articleUpdatePlan.reduce((count, plan) => {
      return count + plan.fieldFills.length
    }, 0),
    reusedArticleUpdateCount: articleUpdatePlan.filter((plan) => {
      return plan.fieldFills.length > 0
    }).length,
    routeArticleSnapshotLinkCount: articleRoutePlan.filter((entry) => {
      return entry.snapshotProjectArticleLink
    }).length,
  }
}

export const getProjectTransferAnalyzeTargetPlan = async ({
  packageFingerprint,
  payloads,
  runner: inputRunner,
}: ProjectTransferAnalyzeTargetInput): Promise<ProjectTransferAnalyzeTargetResult> => {
  const runner = getRunner(inputRunner)
  const articles = payloads.articles ?? []
  const assetManifestEntries = payloads.assetManifest?.entries ?? []
  const importedProject = payloads.project ?? null
  const duplicateDetection = await getProjectTransferDuplicateImportDetection({packageFingerprint, runner})
  const articleReferenceBlockers = getArticleReferenceBlockers({articles, assetManifestEntries})
  const articleMatchAnalysis = await getArticleMatchAnalysis({articles, runner})
  const articleUpdateAnalysis = await getArticleUpdatePlan({
    articleMatches: articleMatchAnalysis.plans,
    articles,
    assetManifestEntries,
    importedProject,
    runner,
  })
  const promptAnalysis = await getPromptPlan({
    projectPrompts: payloads.projectPrompts ?? [],
    prompts: payloads.prompts ?? [],
    runner,
  })
  const routePlan = await getRoutePlan({
    articleImportRoutes: payloads.articleImportRoutes ?? [],
    articleMatches: articleMatchAnalysis.plans,
    articles,
    importRoutes: payloads.importRoutes ?? [],
    importedProject,
    projectArticles: payloads.projectArticles ?? [],
    projectImportRoutes: payloads.projectImportRoutes ?? [],
    runner,
  })
  const articleBlockers = [
    ...articleReferenceBlockers,
    ...articleMatchAnalysis.blockers,
    ...articleUpdateAnalysis.blockers,
  ]
  const assetPromotionPlan = getAssetPromotionPlan({
    articleMatches: articleMatchAnalysis.plans,
    articleUpdatePlan: articleUpdateAnalysis.updatePlan,
    articles,
    assetManifestEntries,
  })
  const baseTargetPlan = {
    articleMatches: articleMatchAnalysis.plans,
    articleRoutePlan: routePlan.articleRoutePlan,
    articleUpdatePlan: articleUpdateAnalysis.updatePlan,
    assetPromotionPlan,
    duplicateImportMatches: duplicateDetection.matches,
    projectPromptPlan: promptAnalysis.projectPromptPlan,
    projectRoutePlan: routePlan.projectRoutePlan,
    promptPlan: promptAnalysis.promptPlan,
  }
  const fidelityValidation = await getProjectTransferFidelityValidation({payloads, runner, targetPlan: baseTargetPlan})
  const overlapCounts = {
    ...getTargetOverlapCounts({
      articleMatches: articleMatchAnalysis.plans,
      articleRoutePlan: routePlan.articleRoutePlan,
      articleUpdatePlan: articleUpdateAnalysis.updatePlan,
      assetPromotionPlan,
      duplicateImportMatchCount: duplicateDetection.matches.length,
      projectRoutePlan: routePlan.projectRoutePlan,
    }),
    ...fidelityValidation.overlapCounts,
  }
  const blockers = [...articleBlockers, ...promptAnalysis.blockers, ...fidelityValidation.blockers]

  return {
    blockers,
    conflictCounts: {
      articleConflictCount: articleBlockers.length,
      humanReviewFidelityConflictCount: fidelityValidation.conflictCounts.humanReviewFidelityConflictCount,
      judgmentConflictCount: fidelityValidation.conflictCounts.judgmentConflictCount,
      projectPromptConflictCount: promptAnalysis.blockers.length,
    },
    judgmentConflictStatus: fidelityValidation.judgmentConflictStatus,
    overlapCounts,
    packageWarnings: [...duplicateDetection.warnings, ...promptAnalysis.warnings, ...routePlan.warnings],
    targetPlan: {...baseTargetPlan, ...fidelityValidation.targetPlan},
  }
}

export const getProjectTransferAnalyzeTargetPlanWithOperationTables = async ({
  cwd,
  envValues,
  layout,
  operationId,
  packageFingerprint,
  payloads,
  runner,
}: ProjectTransferAnalyzeTargetOperationInput): Promise<ProjectTransferAnalyzeTargetResult> => {
  return withProjectTransferOperationTables({
    cwd,
    envValues,
    layout,
    operationId,
    runner,
    work: ({runner: operationRunner}) => {
      return getProjectTransferAnalyzeTargetPlan({packageFingerprint, payloads, runner: operationRunner})
    },
  })
}
