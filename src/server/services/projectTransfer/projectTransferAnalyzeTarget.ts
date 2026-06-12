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
  type ProjectTransferOperationTableSet,
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

export type ProjectTransferAnalyzeTargetRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run?: (statement: string) => Promise<void>
}

type ProjectTransferAnalyzeTargetInput = {
  operationTables?: ProjectTransferOperationTableSet
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

type TargetArticleCandidate = {matchedIdentifiers: TargetArticleMatchedIdentifier[]; targetArticleId: string}

type TargetArticleCandidateDetail = TargetArticleCandidate & {targetArticle: TargetArticleRow}

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

type TargetArticleMatchRow = TargetArticleRow & {matchedKey: string; matchedValue: string; sourceArticleId: string}

type ProjectTransferTargetAnalysisTableSet = {
  articleIds: string
  articleIdentifiers: string
  articleMatches: string
  promptHashes: string
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

const getSqlValues = (rows: readonly (readonly unknown[])[]) => {
  return rows
    .map((row) => {
      return `(${row.map(getSqlLiteral).join(', ')})`
    })
    .join(', ')
}

const chunkValues = <T>(values: readonly T[], size: number) => {
  return values.reduce<T[][]>((chunks, value) => {
    const last = chunks.at(-1)

    return last === undefined || last.length >= size ? [...chunks, [value]] : [...chunks.slice(0, -1), [...last, value]]
  }, [])
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

const getProjectTransferTargetAnalysisTableNames = (
  operationTables: ProjectTransferOperationTableSet,
): ProjectTransferTargetAnalysisTableSet => {
  return {
    articleIds: `temp_project_transfer_${operationTables.operationId}_target_article_ids`,
    articleIdentifiers: `temp_project_transfer_${operationTables.operationId}_target_article_identifiers`,
    articleMatches: `temp_project_transfer_${operationTables.operationId}_target_article_matches`,
    promptHashes: `temp_project_transfer_${operationTables.operationId}_target_prompt_hashes`,
  }
}

const getArticleIdentifierRows = (articles: readonly ProjectTransferArticlePayloadRecord[]) => {
  return articles.flatMap((article) => {
    return getProjectTransferStrongIdentifierComparisonKeys(article).map((key) => {
      const parts = getComparisonKeyParts(key)

      return [article.sourceArticleId, parts.kind, parts.normalizedValue, key] as const
    })
  })
}

const getPromptHashRows = (prompts: readonly ProjectTransferPayloadRecord[]) => {
  return prompts.map((prompt) => {
    const sourcePromptId = getStringField(prompt, 'sourcePromptId')
    const computedContentHash = computePromptContentHash(
      getStringField(prompt, 'originalText'),
      getNonEmptyString(getRecordField(prompt, 'transformedText')),
      getNonEmptyString(getRecordField(prompt, 'promptHeading')),
      getNonEmptyString(getRecordField(prompt, 'type')),
    )
    const packageContentHash = getNonEmptyString(getRecordField(prompt, 'contentHash'))

    return [sourcePromptId, computedContentHash, packageContentHash] as const
  })
}

const runCreateTempTable = async ({
  columns,
  runner,
  tableName,
}: {
  columns: readonly string[]
  runner: ProjectTransferAnalyzeTargetRunner
  tableName: string
}) => {
  return runner.run?.(`
    DROP TABLE IF EXISTS ${tableName};
    CREATE TEMP TABLE ${tableName} (
      ${columns.join(',\n')}
    )
  `)
}

const insertTempRows = async ({
  columns,
  rows,
  runner,
  tableName,
}: {
  columns: readonly string[]
  rows: readonly (readonly unknown[])[]
  runner: ProjectTransferAnalyzeTargetRunner
  tableName: string
}) => {
  return chunkValues(rows, 500).reduce<Promise<void>>(async (previous, rowChunk) => {
    await previous

    return rowChunk.length === 0 || runner.run === undefined
      ? undefined
      : runner.run(`
          INSERT INTO ${tableName} (${columns.join(', ')})
          VALUES ${getSqlValues(rowChunk)}
        `)
  }, Promise.resolve())
}

const createLoadedTempTable = async ({
  columnDefinitions,
  columnNames,
  rows,
  runner,
  tableName,
}: {
  columnDefinitions: readonly string[]
  columnNames: readonly string[]
  rows: readonly (readonly unknown[])[]
  runner: ProjectTransferAnalyzeTargetRunner
  tableName: string
}) => {
  await runCreateTempTable({columns: columnDefinitions, runner, tableName})
  await insertTempRows({columns: columnNames, rows, runner, tableName})
}

const loadProjectTransferTargetAnalysisTables = async ({
  articles,
  operationTables,
  prompts,
  runner,
}: {
  articles: readonly ProjectTransferArticlePayloadRecord[]
  operationTables: ProjectTransferOperationTableSet
  prompts: readonly ProjectTransferPayloadRecord[]
  runner: ProjectTransferAnalyzeTargetRunner
}) => {
  const tables = getProjectTransferTargetAnalysisTableNames(operationTables)
  const articleIdRows = articles.map((article) => {
    return [article.sourceArticleId, getNonEmptyString(getRecordField(article, 'articleId'))] as const
  })

  await createLoadedTempTable({
    columnDefinitions: ['source_article_id VARCHAR NOT NULL', 'package_article_id VARCHAR'],
    columnNames: ['source_article_id', 'package_article_id'],
    rows: articleIdRows,
    runner,
    tableName: tables.articleIds,
  })
  await createLoadedTempTable({
    columnDefinitions: [
      'source_article_id VARCHAR NOT NULL',
      'kind VARCHAR NOT NULL',
      'normalized_value VARCHAR NOT NULL',
      'matched_key VARCHAR NOT NULL',
    ],
    columnNames: ['source_article_id', 'kind', 'normalized_value', 'matched_key'],
    rows: getArticleIdentifierRows(articles),
    runner,
    tableName: tables.articleIdentifiers,
  })
  await createLoadedTempTable({
    columnDefinitions: ['source_article_id VARCHAR NOT NULL', 'target_article_id VARCHAR', 'action VARCHAR NOT NULL'],
    columnNames: ['source_article_id', 'target_article_id', 'action'],
    rows: [],
    runner,
    tableName: tables.articleMatches,
  })
  await createLoadedTempTable({
    columnDefinitions: [
      'source_prompt_id VARCHAR NOT NULL',
      'computed_content_hash VARCHAR NOT NULL',
      'package_content_hash VARCHAR',
    ],
    columnNames: ['source_prompt_id', 'computed_content_hash', 'package_content_hash'],
    rows: getPromptHashRows(prompts),
    runner,
    tableName: tables.promptHashes,
  })

  return tables
}

const dropProjectTransferTargetAnalysisTables = async ({
  runner,
  tables,
}: {
  runner: ProjectTransferAnalyzeTargetRunner
  tables: ProjectTransferTargetAnalysisTableSet
}) => {
  return Object.values(tables).reduce<Promise<void>>(async (previous, tableName) => {
    await previous

    return runner.run?.(`DROP TABLE IF EXISTS ${tableName}`)
  }, Promise.resolve())
}

const withProjectTransferTargetAnalysisTables = async <T>({
  articles,
  operationTables,
  prompts,
  runner,
  work,
}: {
  articles: readonly ProjectTransferArticlePayloadRecord[]
  operationTables?: ProjectTransferOperationTableSet
  prompts: readonly ProjectTransferPayloadRecord[]
  runner: ProjectTransferAnalyzeTargetRunner
  work: (tables?: ProjectTransferTargetAnalysisTableSet) => Promise<T>
}) => {
  if (operationTables === undefined || runner.run === undefined) {
    return work()
  }

  const tables = await loadProjectTransferTargetAnalysisTables({articles, operationTables, prompts, runner})

  try {
    const result = await work(tables)
    await dropProjectTransferTargetAnalysisTables({runner, tables})

    return result
  } catch (error) {
    await dropProjectTransferTargetAnalysisTables({runner, tables}).catch(() => {
      return undefined
    })
    throw error
  }
}

const getTargetArticlesByPackageArticleId = async ({
  analysisTables,
  inputs,
  runner,
}: {
  analysisTables?: ProjectTransferTargetAnalysisTableSet
  inputs: readonly ImportedArticleMatchInput[]
  runner: ProjectTransferAnalyzeTargetRunner
}) => {
  const articleIdRows = inputs
    .filter((input) => {
      return input.packageArticleId !== null
    })
    .map((input) => {
      return [input.sourceArticleId, input.packageArticleId] as const
    })

  const rows =
    analysisTables === undefined && articleIdRows.length === 0
      ? []
      : await runner.queryJson<Partial<TargetArticleMatchRow>>(`
      ${
        analysisTables === undefined
          ? `WITH staged_article_id(source_article_id, package_article_id) AS (VALUES ${getSqlValues(articleIdRows)})`
          : ''
      }
      SELECT
        ${getTargetArticleSelectSql()},
        staged_article_id.source_article_id AS sourceArticleId,
        'articleId' AS matchedKey,
        staged_article_id.package_article_id AS matchedValue
      FROM ${analysisTables?.articleIds ?? 'staged_article_id'} staged_article_id
      INNER JOIN app.article a ON a.article_id = staged_article_id.package_article_id
      ORDER BY staged_article_id.source_article_id ASC, a.id ASC
    `)

  return getNormalizedTargetArticleMatchRows({
    inputs,
    rows: rows.map((row) => {
      return {...row, matchedKey: row.matchedKey ?? 'articleId', matchedValue: row.matchedValue ?? row.articleId}
    }),
  })
}

const getNormalizedTargetArticleMatchRows = ({
  inputs,
  rows,
}: {
  inputs: readonly ImportedArticleMatchInput[]
  rows: readonly Partial<TargetArticleMatchRow>[]
}) => {
  return rows.flatMap((row) => {
    const matchedKey = typeof row.matchedKey === 'string' ? row.matchedKey : ''
    const matchedValue =
      typeof row.matchedValue === 'string'
        ? row.matchedValue
        : matchedKey === 'articleId'
          ? row.articleId
          : getComparisonKeyParts(matchedKey as ProjectTransferStrongIdentifierComparisonKey).normalizedValue
    const sourceArticleIds =
      typeof row.sourceArticleId === 'string'
        ? [row.sourceArticleId]
        : inputs
            .filter((input) => {
              return matchedKey === 'articleId'
                ? input.packageArticleId !== null && input.packageArticleId === row.articleId
                : input.identifierKeys.includes(matchedKey as ProjectTransferStrongIdentifierComparisonKey)
            })
            .map((input) => {
              return input.sourceArticleId
            })

    return matchedKey === '' || typeof matchedValue !== 'string'
      ? []
      : sourceArticleIds.map((sourceArticleId) => {
          return {...row, matchedKey, matchedValue, sourceArticleId} as TargetArticleMatchRow
        })
  })
}

const getTargetArticlesByIdentifier = async ({
  analysisTables,
  inputs,
  runner,
}: {
  analysisTables?: ProjectTransferTargetAnalysisTableSet
  inputs: readonly ImportedArticleMatchInput[]
  runner: ProjectTransferAnalyzeTargetRunner
}) => {
  const identifierRows = [
    ...new Map(
      inputs
        .flatMap((input) => {
          return input.identifierKeys.map((key) => {
            const parts = getComparisonKeyParts(key)

            return [key, [input.sourceArticleId, parts.kind, parts.normalizedValue, key] as const] as const
          })
        })
        .map((entry) => {
          return [`${entry[1][0]}\u0000${entry[0]}`, entry[1]] as const
        }),
    ).values(),
  ]
  const rows =
    analysisTables === undefined && identifierRows.length === 0
      ? []
      : await runner.queryJson<Partial<TargetArticleMatchRow>>(`
      ${
        analysisTables === undefined
          ? `WITH staged_article_identifier(source_article_id, kind, normalized_value, matched_key) AS (VALUES ${getSqlValues(identifierRows)})`
          : ''
      }
      SELECT
        ${getTargetArticleSelectSql()},
        staged_article_identifier.source_article_id AS sourceArticleId,
        staged_article_identifier.matched_key AS matchedKey,
        staged_article_identifier.normalized_value AS matchedValue
      FROM app.article_identifier ai
      INNER JOIN ${analysisTables?.articleIdentifiers ?? 'staged_article_identifier'} staged_article_identifier
        ON staged_article_identifier.kind = ai.kind
        AND ai.normalized_value = staged_article_identifier.normalized_value
      INNER JOIN app.article a ON a.id = ai.article_id
      ORDER BY staged_article_identifier.source_article_id ASC, a.id ASC, ai.kind ASC, ai.normalized_value ASC
    `)

  return getNormalizedTargetArticleMatchRows({inputs, rows})
}

const getCandidateArticleMap = ({
  input,
  rows,
}: {
  input: ImportedArticleMatchInput
  rows: readonly TargetArticleMatchRow[]
}) => {
  const candidateRows = rows
    .filter((row) => {
      return row.sourceArticleId === input.sourceArticleId
    })
    .map((row) => {
      return {
        matchedIdentifier: {
          identifierType: getIdentifierTypeFromKey(row.matchedKey),
          key: row.matchedKey,
          value: row.matchedValue,
        },
        targetArticle: row,
      }
    })

  return candidateRows.reduce<Map<string, TargetArticleCandidateDetail>>((candidateMap, row) => {
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

const getPlanCandidates = (candidates: readonly TargetArticleCandidateDetail[]) => {
  return candidates.map((candidate): TargetArticleCandidate => {
    return {matchedIdentifiers: candidate.matchedIdentifiers, targetArticleId: candidate.targetArticleId}
  })
}

const getInitialArticleMatchPlans = ({
  inputs,
  rows,
}: {
  inputs: readonly ImportedArticleMatchInput[]
  rows: readonly TargetArticleMatchRow[]
}) => {
  const candidateDetailsBySourceArticleId = inputs.reduce<Record<string, TargetArticleCandidateDetail[]>>(
    (candidateMap, input) => {
      return {...candidateMap, [input.sourceArticleId]: [...getCandidateArticleMap({input, rows}).values()]}
    },
    {},
  )
  const blockers = inputs.flatMap((input) => {
    const candidates = candidateDetailsBySourceArticleId[input.sourceArticleId] ?? []

    return [
      ...getAmbiguousIdentifierBlockers({candidates, sourceArticleId: input.sourceArticleId}),
      ...getIdentifierConflictBlocker({candidates, sourceArticleId: input.sourceArticleId}),
    ]
  })
  const plans = inputs.map((input): ArticleMatchPlan => {
    const candidates = candidateDetailsBySourceArticleId[input.sourceArticleId] ?? []
    const sourceBlockers = blockers.filter((blocker) => {
      return blocker.scope === `articles.${input.sourceArticleId}`
    })
    const selectedTargetArticleId =
      candidates.length === 1 && sourceBlockers.length === 0 ? (candidates[0]?.targetArticleId ?? null) : null
    const action = sourceBlockers.length > 0 ? 'blocked' : selectedTargetArticleId === null ? 'create' : 'reuse'

    return {
      action,
      candidates: getPlanCandidates(candidates),
      conflicts: sourceBlockers.map((blocker) => {
        return blocker.code
      }),
      identifierKeys: input.identifierKeys,
      packageArticleId: input.packageArticleId,
      selectedTargetArticleId,
      sourceArticleId: input.sourceArticleId,
    }
  })

  return {blockers, candidateDetailsBySourceArticleId, plans}
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

const getSelectedTargetArticleBySourceFromCandidateDetails = ({
  candidateDetailsBySourceArticleId,
  plans,
}: {
  candidateDetailsBySourceArticleId: Record<string, readonly TargetArticleCandidateDetail[]>
  plans: readonly ArticleMatchPlan[]
}) => {
  return plans.reduce<Record<string, TargetArticleRow | null>>((articleMap, plan) => {
    const targetArticle =
      plan.selectedTargetArticleId === null
        ? null
        : (candidateDetailsBySourceArticleId[plan.sourceArticleId]?.find((candidate) => {
            return candidate.targetArticleId === plan.selectedTargetArticleId
          })?.targetArticle ?? null)

    return {...articleMap, [plan.sourceArticleId]: targetArticle}
  }, {})
}

const replaceProjectTransferArticleMatchPlanTable = async ({
  analysisTables,
  plans,
  runner,
}: {
  analysisTables?: ProjectTransferTargetAnalysisTableSet
  plans: readonly ArticleMatchPlan[]
  runner: ProjectTransferAnalyzeTargetRunner
}) => {
  return analysisTables === undefined || runner.run === undefined
    ? undefined
    : createLoadedTempTable({
        columnDefinitions: [
          'source_article_id VARCHAR NOT NULL',
          'target_article_id VARCHAR',
          'action VARCHAR NOT NULL',
        ],
        columnNames: ['source_article_id', 'target_article_id', 'action'],
        rows: plans.map((plan) => {
          return [plan.sourceArticleId, plan.selectedTargetArticleId, plan.action] as const
        }),
        runner,
        tableName: analysisTables.articleMatches,
      })
}

const getArticleMatchAnalysis = async ({
  analysisTables,
  articles,
  runner,
}: {
  analysisTables?: ProjectTransferTargetAnalysisTableSet
  articles: readonly ProjectTransferArticlePayloadRecord[]
  runner: ProjectTransferAnalyzeTargetRunner
}) => {
  const inputs = getImportedArticleInputs(articles)
  const [articleIdRows, identifierRows] = await Promise.all([
    getTargetArticlesByPackageArticleId({analysisTables, inputs, runner}),
    getTargetArticlesByIdentifier({analysisTables, inputs, runner}),
  ])
  const initial = getInitialArticleMatchPlans({inputs, rows: [...articleIdRows, ...identifierRows]})
  const collapseBlockers = getCollapseBlockers(initial.plans)
  const plans = applyCollapseBlockers(initial.plans, collapseBlockers)
  const targetArticleBySource = getSelectedTargetArticleBySourceFromCandidateDetails({
    candidateDetailsBySourceArticleId: initial.candidateDetailsBySourceArticleId,
    plans,
  })

  return {blockers: [...initial.blockers, ...collapseBlockers], plans, targetArticleBySource}
}

const getResolvedArticleIdBySource = (plans: readonly ArticleMatchPlan[]) => {
  return plans.reduce<Record<string, string | null>>((articleMap, plan) => {
    return {...articleMap, [plan.sourceArticleId]: plan.selectedTargetArticleId}
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
  analysisTables,
  runner,
  targetArticleIds,
}: {
  analysisTables?: ProjectTransferTargetAnalysisTableSet
  runner: ProjectTransferAnalyzeTargetRunner
  targetArticleIds: readonly string[]
}) => {
  const targetArticleRows = targetArticleIds.map((targetArticleId) => {
    return [targetArticleId] as const
  })
  const selectedArticleSql =
    analysisTables === undefined
      ? `(VALUES ${getSqlValues(targetArticleRows)})`
      : `(SELECT DISTINCT target_article_id FROM ${analysisTables.articleMatches} WHERE target_article_id IS NOT NULL)`

  return analysisTables === undefined && targetArticleRows.length === 0
    ? []
    : runner.queryJson<ReferencingProjectRow>(`
      WITH referenced_article AS (
        SELECT pa.article_id AS targetArticleId, pa.project_id AS projectId
        FROM app.project_article pa
        INNER JOIN ${selectedArticleSql} selected_article(target_article_id) ON selected_article.target_article_id = pa.article_id
        UNION
        SELECT air.article_id AS targetArticleId, pir.project_id AS projectId
        FROM app.article_import_route air
        INNER JOIN app.project_import_route pir ON pir.import_route_id = air.import_route_id
        INNER JOIN ${selectedArticleSql} selected_article(target_article_id) ON selected_article.target_article_id = air.article_id
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
  analysisTables,
  articleMatches,
  articles,
  assetManifestEntries,
  importedProject,
  runner,
  targetArticleBySource,
}: {
  analysisTables?: ProjectTransferTargetAnalysisTableSet
  articleMatches: readonly ArticleMatchPlan[]
  articles: readonly ProjectTransferArticlePayloadRecord[]
  assetManifestEntries: readonly ProjectTransferAssetManifestEntry[]
  importedProject: ProjectTransferPayloadByKey['project'] | null
  runner: ProjectTransferAnalyzeTargetRunner
  targetArticleBySource: Record<string, TargetArticleRow | null>
}) => {
  const reusedMatches = articleMatches.filter((match) => {
    return match.action === 'reuse' && match.selectedTargetArticleId !== null
  })
  const referencingProjects = await getReferencingProjects({
    analysisTables,
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
    const targetArticle = targetArticleBySource[match.sourceArticleId] as TargetArticleRow
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
          const targetArticle = targetArticleBySource[match.sourceArticleId] as TargetArticleRow
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
  analysisTables,
  contentHashes,
  runner,
}: {
  analysisTables?: ProjectTransferTargetAnalysisTableSet
  contentHashes: readonly string[]
  runner: ProjectTransferAnalyzeTargetRunner
}) => {
  const contentHashRows = contentHashes.map((contentHash) => {
    return [contentHash] as const
  })

  return analysisTables === undefined && contentHashRows.length === 0
    ? []
    : runner.queryJson<TargetPromptRow>(`
      ${
        analysisTables === undefined
          ? `WITH staged_prompt_hash(computed_content_hash) AS (VALUES ${getSqlValues(contentHashRows)})`
          : ''
      }
      SELECT
        p.id AS targetPromptId,
        p.content_hash AS contentHash,
        p.archived
      FROM app.prompt p
      INNER JOIN ${
        analysisTables?.promptHashes ?? 'staged_prompt_hash'
      } staged_prompt_hash ON staged_prompt_hash.computed_content_hash = p.content_hash
      ORDER BY p.id ASC
    `)
}

const getPromptPlan = async ({
  analysisTables,
  projectPrompts,
  prompts,
  runner,
}: {
  analysisTables?: ProjectTransferTargetAnalysisTableSet
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
    analysisTables,
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
  operationTables,
  routeValues,
  runner,
}: {
  operationTables?: ProjectTransferOperationTableSet
  routeValues: readonly string[]
  runner: ProjectTransferAnalyzeTargetRunner
}) => {
  const routeRows = routeValues.map((routeValue) => {
    return [routeValue] as const
  })

  return operationTables === undefined && routeRows.length === 0
    ? []
    : runner.queryJson<TargetImportRouteRow>(`
      ${
        operationTables === undefined
          ? `WITH staged_import_route(route_value) AS (VALUES ${getSqlValues(routeRows)})`
          : `WITH staged_import_route AS (
              SELECT DISTINCT route_payload->>'route' AS route_value
              FROM ${operationTables.tableNames.importRoutes} staged_import_route_table,
                UNNEST(json_extract(staged_import_route_table.payload_json, '$[*]')) AS route_rows(route_payload)
            )`
      }
      SELECT
        ir.id AS targetImportRouteId,
        ir.route,
        ir.active
      FROM app.import_route ir
      INNER JOIN staged_import_route ON staged_import_route.route_value = ir.route
      ORDER BY ir.route ASC, ir.active DESC, ir.id ASC
    `)
}

const getRouteArticles = async ({
  operationTables,
  runner,
  targetImportRouteIds,
}: {
  operationTables?: ProjectTransferOperationTableSet
  runner: ProjectTransferAnalyzeTargetRunner
  targetImportRouteIds: readonly string[]
}) => {
  const targetRouteRows = targetImportRouteIds.map((routeId) => {
    return [routeId] as const
  })

  return operationTables === undefined && targetRouteRows.length === 0
    ? []
    : runner.queryJson<RouteArticleRow>(`
      ${
        operationTables === undefined
          ? `WITH target_route(target_import_route_id) AS (VALUES ${getSqlValues(targetRouteRows)})`
          : `WITH target_route AS (
              SELECT DISTINCT ir.id AS target_import_route_id
              FROM ${operationTables.tableNames.importRoutes} staged_import_route_table,
                UNNEST(json_extract(staged_import_route_table.payload_json, '$[*]')) AS staged_import_route(route_payload)
              INNER JOIN app.import_route ir ON ir.route = (staged_import_route.route_payload->>'route')
              WHERE ir.active
            )`
      }
      SELECT
        air.import_route_id AS targetImportRouteId,
        air.article_id AS targetArticleId,
        a.article_created_at AS articleCreatedAt
      FROM app.article_import_route air
      INNER JOIN target_route ON target_route.target_import_route_id = air.import_route_id
      INNER JOIN app.article a ON a.id = air.article_id
      ORDER BY air.import_route_id ASC, air.article_id ASC
    `)
}

const getProjectRouteReferences = async ({
  operationTables,
  runner,
  targetImportRouteIds,
}: {
  operationTables?: ProjectTransferOperationTableSet
  runner: ProjectTransferAnalyzeTargetRunner
  targetImportRouteIds: readonly string[]
}) => {
  const targetRouteRows = targetImportRouteIds.map((routeId) => {
    return [routeId] as const
  })

  return operationTables === undefined && targetRouteRows.length === 0
    ? []
    : runner.queryJson<ProjectRouteReferenceRow>(`
      ${
        operationTables === undefined
          ? `WITH target_route(target_import_route_id) AS (VALUES ${getSqlValues(targetRouteRows)})`
          : `WITH target_route AS (
              SELECT DISTINCT ir.id AS target_import_route_id
              FROM ${operationTables.tableNames.importRoutes} staged_import_route_table,
                UNNEST(json_extract(staged_import_route_table.payload_json, '$[*]')) AS staged_import_route(route_payload)
              INNER JOIN app.import_route ir ON ir.route = (staged_import_route.route_payload->>'route')
              WHERE ir.active
            )`
      }
      SELECT
        pir.import_route_id AS targetImportRouteId,
        pir.project_id AS projectId,
        p.archived,
        p.date_from AS dateFrom,
        p.date_to AS dateTo
      FROM app.project_import_route pir
      INNER JOIN target_route ON target_route.target_import_route_id = pir.import_route_id
      INNER JOIN app.project p ON p.id = pir.project_id
      ORDER BY pir.import_route_id ASC, pir.project_id ASC
    `)
}

const getProjectArticleReferences = async ({
  analysisTables,
  operationTables,
  projectIds,
  runner,
  targetArticleIds,
}: {
  analysisTables?: ProjectTransferTargetAnalysisTableSet
  operationTables?: ProjectTransferOperationTableSet
  projectIds: readonly string[]
  runner: ProjectTransferAnalyzeTargetRunner
  targetArticleIds: readonly string[]
}) => {
  const projectRows = projectIds.map((projectId) => {
    return [projectId] as const
  })
  const targetArticleRows = targetArticleIds.map((articleId) => {
    return [articleId] as const
  })

  return (analysisTables === undefined || operationTables === undefined)
    && (projectRows.length === 0 || targetArticleRows.length === 0)
    ? []
    : runner.queryJson<ProjectArticleReferenceRow>(`
      ${
        analysisTables !== undefined && operationTables !== undefined
          ? `WITH target_project AS (
              SELECT DISTINCT pir.project_id
              FROM ${operationTables.tableNames.importRoutes} staged_import_route_table,
                UNNEST(json_extract(staged_import_route_table.payload_json, '$[*]')) AS staged_import_route(route_payload)
              INNER JOIN app.import_route ir ON ir.route = (staged_import_route.route_payload->>'route')
              INNER JOIN app.project_import_route pir ON pir.import_route_id = ir.id
              WHERE ir.active
            ),
            target_article AS (
              SELECT DISTINCT target_article_id
              FROM ${analysisTables.articleMatches}
              WHERE target_article_id IS NOT NULL
            )`
          : `WITH target_project(project_id) AS (VALUES ${getSqlValues(projectRows)}),
            target_article(target_article_id) AS (VALUES ${getSqlValues(targetArticleRows)})`
      }
      SELECT
        pa.project_id AS projectId,
        pa.article_id AS targetArticleId
      FROM app.project_article pa
      INNER JOIN target_project ON target_project.project_id = pa.project_id
      INNER JOIN target_article ON target_article.target_article_id = pa.article_id
      ORDER BY pa.project_id ASC, pa.article_id ASC
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
  targetArticleBySource,
}: {
  activeRouteBySource: Record<string, TargetImportRouteRow | null>
  articleImportRoutes: readonly ProjectTransferPayloadRecord[]
  articles: readonly ProjectTransferArticlePayloadRecord[]
  articleMatches: readonly ArticleMatchPlan[]
  projectArticleReferences: readonly ProjectArticleReferenceRow[]
  projectArticles: readonly ProjectTransferPayloadRecord[]
  projectRouteReferences: readonly ProjectRouteReferenceRow[]
  routeArticles: readonly RouteArticleRow[]
  targetArticleBySource: Record<string, TargetArticleRow | null>
}) => {
  const targetArticleBySourceId = getResolvedArticleIdBySource(articleMatches)
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
    const targetArticleId = targetArticleBySourceId[sourceArticleId] ?? null
    const targetArticle = targetArticleBySource[sourceArticleId] ?? null
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
  analysisTables,
  articleImportRoutes,
  articleMatches,
  articles,
  importRoutes,
  importedProject,
  operationTables,
  projectArticles,
  projectImportRoutes,
  runner,
  targetArticleBySource,
}: {
  analysisTables?: ProjectTransferTargetAnalysisTableSet
  articleImportRoutes: readonly ProjectTransferPayloadRecord[]
  articleMatches: readonly ArticleMatchPlan[]
  articles: readonly ProjectTransferArticlePayloadRecord[]
  importRoutes: readonly ProjectTransferPayloadRecord[]
  importedProject: ProjectTransferPayloadByKey['project'] | null
  operationTables?: ProjectTransferOperationTableSet
  projectArticles: readonly ProjectTransferPayloadRecord[]
  projectImportRoutes: readonly ProjectTransferPayloadRecord[]
  runner: ProjectTransferAnalyzeTargetRunner
  targetArticleBySource: Record<string, TargetArticleRow | null>
}) => {
  const routeValues = [
    ...new Set(
      importRoutes.map((route) => {
        return getStringField(route, 'route')
      }),
    ),
  ]
  const targetRoutes = await getTargetImportRoutes({operationTables, routeValues, runner})
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
  const routeArticles = await getRouteArticles({operationTables, runner, targetImportRouteIds})
  const projectRouteReferences = await getProjectRouteReferences({operationTables, runner, targetImportRouteIds})
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
    analysisTables,
    operationTables,
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
    targetArticleBySource,
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
  operationTables,
  packageFingerprint,
  payloads,
  runner: inputRunner,
}: ProjectTransferAnalyzeTargetInput): Promise<ProjectTransferAnalyzeTargetResult> => {
  const runner = getRunner(inputRunner)
  const articles = payloads.articles ?? []
  const assetManifestEntries = payloads.assetManifest?.entries ?? []
  const importedProject = payloads.project ?? null
  const prompts = payloads.prompts ?? []

  return withProjectTransferTargetAnalysisTables({
    articles,
    operationTables,
    prompts,
    runner,
    work: async (analysisTables) => {
      const duplicateDetection = await getProjectTransferDuplicateImportDetection({packageFingerprint, runner})
      const articleReferenceBlockers = getArticleReferenceBlockers({articles, assetManifestEntries})
      const articleMatchAnalysis = await getArticleMatchAnalysis({analysisTables, articles, runner})
      await replaceProjectTransferArticleMatchPlanTable({analysisTables, plans: articleMatchAnalysis.plans, runner})
      const articleUpdateAnalysis = await getArticleUpdatePlan({
        analysisTables,
        articleMatches: articleMatchAnalysis.plans,
        articles,
        assetManifestEntries,
        importedProject,
        runner,
        targetArticleBySource: articleMatchAnalysis.targetArticleBySource,
      })
      const promptAnalysis = await getPromptPlan({
        analysisTables,
        projectPrompts: payloads.projectPrompts ?? [],
        prompts,
        runner,
      })
      const routePlan = await getRoutePlan({
        analysisTables,
        articleImportRoutes: payloads.articleImportRoutes ?? [],
        articleMatches: articleMatchAnalysis.plans,
        articles,
        importRoutes: payloads.importRoutes ?? [],
        importedProject,
        operationTables,
        projectArticles: payloads.projectArticles ?? [],
        projectImportRoutes: payloads.projectImportRoutes ?? [],
        runner,
        targetArticleBySource: articleMatchAnalysis.targetArticleBySource,
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
      const fidelityValidation = await getProjectTransferFidelityValidation({
        payloads,
        runner,
        targetPlan: baseTargetPlan,
      })
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
    },
  })
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
    work: ({runner: operationRunner, tables}) => {
      return getProjectTransferAnalyzeTargetPlan({
        operationTables: tables,
        packageFingerprint,
        payloads,
        runner: operationRunner,
      })
    },
  })
}
