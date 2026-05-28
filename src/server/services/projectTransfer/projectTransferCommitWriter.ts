import {randomUUID} from 'node:crypto'

import type {ProjectTransferHistoryRecord} from '../../../db/schemaTypes.ts'
import {computePromptContentHash} from '../../utils/computePromptContentHash.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import {
  getDateValue,
  getJsonValue,
  getQuotedStringList,
  getSqlLiteral,
  getTimestampLiteral,
} from '../appQueryHelpers.ts'
import {getOrCreateImmutablePromptTx} from '../immutablePromptService.ts'
import {getProjectMartDirtyRefreshStateService} from '../projectMartDirtyRefreshStateService.ts'
import type {ProjectTransferImportPlanArtifact} from './projectTransferAnalyze.ts'
import type {ProjectTransferTargetPlan} from './projectTransferAnalyzeTarget.ts'
import type {ProjectTransferCommitPromotionResult} from './projectTransferCommitRollback.ts'
import type {ProjectTransferImportCompletionPayload} from './projectTransferContracts.ts'
import {getProjectTransferCanonicalJson} from './projectTransferFingerprint.ts'
import {getProjectTransferHistoryRepository} from './projectTransferHistoryRepository.ts'
import {getProjectTransferNormalizedArticleIdentifiers} from './projectTransferIdentifierNormalization.ts'
import type {
  ProjectTransferArticlePayloadRecord,
  ProjectTransferPayloadByKey,
  ProjectTransferPayloadRecord,
  ProjectTransferProjectPayload,
} from './projectTransferPayloadSchemas.ts'
import type {ProjectTransferPackageWarning, ProjectTransferPayloadKey} from './projectTransferSchemas.ts'

type ProjectTransferCommitWriterTx = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type ProjectTransferCommitWriterDatabase = ProjectTransferCommitWriterTx & {
  transaction: <T>(work: (tx: ProjectTransferCommitWriterTx) => Promise<T> | T) => Promise<T>
}

export type ProjectTransferCommitWriterInput = {
  commitId: string
  database?: ProjectTransferCommitWriterDatabase
  now?: Date
  payloads: Partial<ProjectTransferPayloadByKey>
  plan: ProjectTransferImportPlanArtifact
  promotion: ProjectTransferCommitPromotionResult
  schemaVersion: number
  sessionId: string
}

export type ProjectTransferCommitAppWriteResult = {
  articleIdBySourceId: Record<string, string>
  completion: ProjectTransferImportCompletionPayload
  history: ProjectTransferHistoryRecord
  importWarnings: ProjectTransferPackageWarning[]
  projectId: string
  projectName: string
  promptIdBySourceId: Record<string, string>
  routeIdBySourceId: Record<string, string>
}

type DependencyResolutionState = {
  modelTargetBySourceId?: Record<string, string>
  providerTargetBySourceId?: Record<string, string>
}

type ArticleField = keyof typeof articleColumnByPayloadField
type ArticleMatchPlan = ProjectTransferTargetPlan['articleMatches'][number]
type ArticleRoutePlanEntry = ProjectTransferTargetPlan['articleRoutePlan'][number]
type HumanReviewPlanEntry = NonNullable<ProjectTransferTargetPlan['humanReviewPlan']>[number]
type JudgmentAssessmentPlanEntry = NonNullable<ProjectTransferTargetPlan['judgmentAssessmentPlan']>[number]
type JudgmentPlanEntry = NonNullable<ProjectTransferTargetPlan['judgmentPlan']>[number]
type ProjectRoutePlanEntry = ProjectTransferTargetPlan['projectRoutePlan'][number]
type PromptPlanEntry = ProjectTransferTargetPlan['promptPlan'][number]
type ProjectPromptPlanEntry = ProjectTransferTargetPlan['projectPromptPlan'][number]

type TargetArticleFieldRow = Record<ArticleField, unknown> & {id: string}
type TargetJudgmentRow = {
  answeredOriginal: string | null
  answeredOriginalAsArray: unknown
  confidenceOriginal: number | null
  deleteGeneration: number | null
  explanation: string | null
  id: string
  isAnswered: boolean | null
  quotes: unknown
  articleId: string
  modelId: string
  promptId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}
type TargetJudgmentAssessmentRow = {
  assessmentComment: string | null
  assessmentIsCorrect: boolean | null
  id: string
  judgmentId: string
}

type JudgmentCommitRow = {
  action: 'insert' | 'reuse'
  answeredOriginal: string | null
  answeredOriginalAsArray: string[]
  articleId: string
  chunkingStrategy: string | null
  confidenceOriginal: number
  createdAt: Date
  deleteGeneration: number
  explanation: string | null
  id: string
  modelId: string
  promptId: string
  quotes: unknown[]
  snapshotProjectModelName: string | null
  sourceJudgmentId: string
  updatedAt: Date
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

type JudgmentAssessmentCommitRow = {
  action: 'insert' | 'reuse'
  assessmentComment: string | null
  assessmentIsCorrect: boolean
  createdAt: Date
  id: string
  judgmentId: string
  sourceJudgmentAssessmentId: string
  updatedAt: Date
}

type HumanJudgmentCommitRow = {
  answer: string | null
  articleId: string
  comment: string | null
  createdAt: Date
  id: string
  isAnswered: boolean
  projectId: string
  promptId: string
  sourceHumanJudgmentId: string
  updatedAt: Date
}

type HumanJudgmentSummaryCommitRow = {
  answer: string | null
  articleId: string
  createdAt: Date
  id: string
  origin: string
  projectId: string
  sourceHumanJudgmentSummaryId: string
  updatedAt: Date
}

type ReviewCommitRow = {
  articleId: string
  createdAt: Date
  id: string
  opened: boolean
  projectId: string
  sections: Record<string, {comment: string | null; reviewed: boolean}>
  sourceReviewId: string
  updatedAt: Date
}

const articleColumnByPayloadField = {
  articleAuthors: 'article_authors',
  articleCreatedAt: 'article_created_at',
  articleId: 'article_id',
  articleSummary: 'article_summary',
  articleTitle: 'article_title',
  articleUpdatedAt: 'article_updated_at',
  articleVersion: 'article_version',
  arxivId: 'arxiv_id',
  biorxivId: 'biorxiv_id',
  contentHash: 'content_hash',
  doi: 'doi',
  fullText: 'full_text',
  fullTextAssets: 'full_text_assets',
  fullTextCharCount: 'full_text_char_count',
  fullTextConversionAttempts: 'full_text_conversion_attempts',
  fullTextConversionError: 'full_text_conversion_error',
  fullTextConversionMetadata: 'full_text_conversion_metadata',
  fullTextConversionModelId: 'full_text_conversion_model_id',
  fullTextConversionStatus: 'full_text_conversion_status',
  fullTextFetchedAt: 'full_text_fetched_at',
  fullTextHtml: 'full_text_html',
  fullTextOriginalFormat: 'full_text_original_format',
  fullTextPdf: 'full_text_pdf',
  fullTextSource: 'full_text_source',
  importRoute: 'import_route',
  medrxivId: 'medrxiv_id',
  originalData: 'original_data',
  publicationStatus: 'publication_status',
  pubmedId: 'pubmed_id',
  sourceMetadata: 'source_metadata',
  url: 'url',
} as const

const articleJsonFields = new Set<ArticleField>([
  'fullTextAssets',
  'fullTextConversionMetadata',
  'originalData',
  'sourceMetadata',
])
const articleArrayFields = new Set<ArticleField>(['articleAuthors'])
const articleDateFields = new Set<ArticleField>(['articleCreatedAt', 'articleUpdatedAt', 'fullTextFetchedAt'])
const articleNumberFields = new Set<ArticleField>(['articleVersion', 'fullTextCharCount', 'fullTextConversionAttempts'])
const articleStringFields = new Set<ArticleField>(
  Object.keys(articleColumnByPayloadField).filter((field) => {
    return (
      !articleJsonFields.has(field as ArticleField)
      && !articleArrayFields.has(field as ArticleField)
      && !articleDateFields.has(field as ArticleField)
      && !articleNumberFields.has(field as ArticleField)
    )
  }) as ArticleField[],
)
const articleFieldSelectSql = Object.entries(articleColumnByPayloadField)
  .map(([field, column]) => {
    return articleJsonFields.has(field as ArticleField) || articleArrayFields.has(field as ArticleField)
      ? `TO_JSON(${column}) AS ${field}`
      : `${column} AS ${field}`
  })
  .join(',\n')
const commitWriterInsertBatchSize = 500

const failCommitWriter = (message: string): never => {
  throw new Error(`Project transfer commit writer: ${message}`)
}

const getValueChunks = <TValue>(values: readonly TValue[], chunkSize = commitWriterInsertBatchSize): TValue[][] => {
  return values.length === 0
    ? []
    : values.length <= chunkSize
      ? [[...values]]
      : [[...values.slice(0, chunkSize)], ...getValueChunks(values.slice(chunkSize), chunkSize)]
}

const runChunks = async <TValue>(
  values: readonly TValue[],
  work: (chunk: readonly TValue[]) => Promise<void>,
): Promise<void> => {
  await getValueChunks(values).reduce<Promise<void>>(async (previous, chunk) => {
    await previous
    return work(chunk)
  }, Promise.resolve())
}

const queryChunks = async <TValue, TRow>(
  values: readonly TValue[],
  work: (chunk: readonly TValue[]) => Promise<TRow[]>,
): Promise<TRow[]> => {
  return getValueChunks(values).reduce<Promise<TRow[]>>(async (previous, chunk) => {
    const rows = await previous
    const chunkRows = await work(chunk)

    return [...rows, ...chunkRows]
  }, Promise.resolve([]))
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getRecordField = (record: Record<string, unknown>, field: string) => {
  return Object.prototype.hasOwnProperty.call(record, field) ? record[field] : null
}

const getRequiredString = (value: unknown, label: string) => {
  return typeof value === 'string' && value.trim() !== '' ? value : failCommitWriter(`${label} is required`)
}

const getNullableString = (value: unknown) => {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

const getNullableNumber = (value: unknown) => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const getNonNegativeInteger = (value: unknown, defaultValue: number) => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : defaultValue
}

const getBoolean = (value: unknown, defaultValue: boolean) => {
  return typeof value === 'boolean' ? value : defaultValue
}

const getStringArray = (value: unknown) => {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => {
        return typeof entry === 'string'
      })
    : null
}

const getArrayValue = (value: unknown) => {
  const parsed = getJsonValue(value)

  return Array.isArray(parsed)
    ? (parsed as readonly unknown[]).map((entry) => {
        return entry
      })
    : []
}

const valuesEquivalent = (left: unknown, right: unknown) => {
  return getProjectTransferCanonicalJson(left ?? null) === getProjectTransferCanonicalJson(right ?? null)
}

const getJsonLiteral = (value: unknown) => {
  return value === null || value === undefined ? 'NULL' : `CAST(${getSqlLiteral(JSON.stringify(value))} AS JSON)`
}

const getNullableDateLiteral = (value: unknown) => {
  const date = getDateValue(value)

  return date === null ? 'NULL' : getTimestampLiteral(date)
}

const getDateOrDefault = (value: unknown, defaultValue: Date) => {
  return getDateValue(value) ?? defaultValue
}

const getArticleFieldSqlLiteral = (field: ArticleField, value: unknown) => {
  return articleJsonFields.has(field)
    ? getJsonLiteral(value ?? null)
    : articleArrayFields.has(field)
      ? getSqlLiteral(getStringArray(value))
      : articleDateFields.has(field)
        ? getNullableDateLiteral(value)
        : articleNumberFields.has(field)
          ? getSqlLiteral(getNullableNumber(value))
          : getSqlLiteral(getNullableString(value))
}

const getArticlePayloadField = (article: ProjectTransferArticlePayloadRecord, field: ArticleField) => {
  return getRecordField(article, field)
}

const getArticleSqlValue = (article: ProjectTransferArticlePayloadRecord, field: ArticleField) => {
  return field === 'articleTitle'
    ? getSqlLiteral(getRequiredString(getArticlePayloadField(article, field), `article.${field}`))
    : getArticleFieldSqlLiteral(field, getArticlePayloadField(article, field))
}

const getCreatedArticleValuesSql = ({
  article,
  articleId,
  now,
}: {
  article: ProjectTransferArticlePayloadRecord
  articleId: string
  now: Date
}) => {
  return `(
    ${getSqlLiteral(articleId)},
    ${Object.keys(articleColumnByPayloadField)
      .map((field) => {
        return getArticleSqlValue(article, field as ArticleField)
      })
      .join(', ')},
    ${getTimestampLiteral(now)},
    ${getTimestampLiteral(now)}
  )`
}

const getDependencyResolutionState = (plan: ProjectTransferImportPlanArtifact): DependencyResolutionState => {
  return isRecord(plan.dependencyResolution) ? (plan.dependencyResolution as DependencyResolutionState) : {}
}

const getPayloadArrayBySourceId = <TRecord extends ProjectTransferPayloadRecord>(
  records: readonly TRecord[],
  sourceField: string,
) => {
  return records.reduce<Record<string, TRecord>>((mapped, record) => {
    const sourceId = getNullableString(getRecordField(record, sourceField))

    return sourceId === null ? mapped : {...mapped, [sourceId]: record}
  }, {})
}

const getArticleBySourceId = (articles: readonly ProjectTransferArticlePayloadRecord[]) => {
  return articles.reduce<Record<string, ProjectTransferArticlePayloadRecord>>((mapped, article) => {
    return {...mapped, [article.sourceArticleId]: article}
  }, {})
}

const getProjectSourceModelId = ({
  models,
  project,
}: {
  models: readonly ProjectTransferPayloadRecord[]
  project: ProjectTransferProjectPayload
}) => {
  const projectModelSignature = getProjectTransferCanonicalJson(project.modelSignature ?? null)
  const matchingModel = models.find((model) => {
    return getProjectTransferCanonicalJson(model.signature ?? null) === projectModelSignature
  })
  const fallbackModel = models.length === 1 ? models[0] : null
  const sourceModelId = getNullableString(getRecordField(matchingModel ?? fallbackModel ?? {}, 'sourceModelId'))

  return sourceModelId ?? failCommitWriter('source project model could not be resolved from package model signature')
}

const getTargetModelId = ({
  plan,
  project,
  models,
}: {
  models: readonly ProjectTransferPayloadRecord[]
  plan: ProjectTransferImportPlanArtifact
  project: ProjectTransferProjectPayload
}) => {
  const sourceModelId = getProjectSourceModelId({models, project})
  const targetModelId = getDependencyResolutionState(plan).modelTargetBySourceId?.[sourceModelId]

  return targetModelId ?? failCommitWriter(`target model is missing for source model ${sourceModelId}`)
}

const getProjectSettings = (project: ProjectTransferProjectPayload) => {
  const settings: Record<string, unknown> = isRecord(project.settings) ? project.settings : {}
  const humanJudgmentMode = settings.humanJudgmentMode === 'summary' ? 'summary' : 'prompt'

  return {
    humanJudgmentMode,
    useAbstract: getBoolean(settings.useAbstract, true),
    useFulltext: getBoolean(settings.useFulltext, false),
    useFulltextNoImages: getBoolean(settings.useFulltextNoImages, false),
    useTitle: getBoolean(settings.useTitle, true),
  }
}

const insertImportedProject = async ({
  now,
  plan,
  project,
  tx,
  models,
}: {
  models: readonly ProjectTransferPayloadRecord[]
  now: Date
  plan: ProjectTransferImportPlanArtifact
  project: ProjectTransferProjectPayload
  tx: ProjectTransferCommitWriterTx
}) => {
  const projectId = randomUUID()
  const settings = getProjectSettings(project)
  const [created] = await tx.queryJson<{id: string; name: string}>(`
    INSERT INTO app.project (
      id,
      name,
      description,
      model_id,
      human_judgment_mode,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      date_from,
      date_to,
      archived,
      created_at,
      updated_at
    ) VALUES (
      ${getSqlLiteral(projectId)},
      ${getSqlLiteral(getRequiredString(project.name, 'project.name'))},
      ${getSqlLiteral(getNullableString(project.description))},
      ${getSqlLiteral(getTargetModelId({models, plan, project}))},
      ${getSqlLiteral(settings.humanJudgmentMode)},
      ${getSqlLiteral(settings.useTitle)},
      ${getSqlLiteral(settings.useAbstract)},
      ${getSqlLiteral(settings.useFulltext)},
      ${getSqlLiteral(settings.useFulltextNoImages)},
      ${getNullableDateLiteral(project.dateFrom)},
      ${getNullableDateLiteral(project.dateTo)},
      FALSE,
      ${getTimestampLiteral(now)},
      ${getTimestampLiteral(now)}
    )
    RETURNING id, name
  `)

  return created ?? failCommitWriter('project insert failed')
}

const getActiveSourcePromptIds = (projectPromptPlan: readonly ProjectPromptPlanEntry[]) => {
  return new Set(
    projectPromptPlan
      .filter((entry) => {
        return entry.enabled && entry.metadata.archived !== true
      })
      .map((entry) => {
        return entry.sourcePromptId
      }),
  )
}

const getPromptIdBySourceId = async ({
  activeSourcePromptIds,
  prompts,
  tx,
}: {
  activeSourcePromptIds: Set<string>
  prompts: readonly ProjectTransferPayloadRecord[]
  tx: ProjectTransferCommitWriterTx
}) => {
  return prompts.reduce<Promise<Record<string, string>>>(async (previous, prompt) => {
    const mapped = await previous
    const sourcePromptId = getRequiredString(getRecordField(prompt, 'sourcePromptId'), 'prompt.sourcePromptId')
    const originalText = getRequiredString(
      getRecordField(prompt, 'originalText'),
      `prompts.${sourcePromptId}.originalText`,
    )
    const promptId = await getOrCreateImmutablePromptTx(tx, {
      archived: !activeSourcePromptIds.has(sourcePromptId) && getBoolean(getRecordField(prompt, 'archived'), false),
      originalText,
      promptHeading: getNullableString(getRecordField(prompt, 'promptHeading')),
      transformedText: getNullableString(getRecordField(prompt, 'transformedText')),
      type: getNullableString(getRecordField(prompt, 'type')),
    })

    return promptId === null
      ? failCommitWriter(`prompt ${sourcePromptId} could not be created`)
      : {...mapped, [sourcePromptId]: promptId}
  }, Promise.resolve({}))
}

const getPlannedPromptHashBySourceId = (prompts: readonly ProjectTransferPayloadRecord[]) => {
  return prompts.reduce<Record<string, string>>((mapped, prompt) => {
    const sourcePromptId = getRequiredString(getRecordField(prompt, 'sourcePromptId'), 'prompt.sourcePromptId')
    const contentHash = computePromptContentHash(
      getRequiredString(getRecordField(prompt, 'originalText'), `prompts.${sourcePromptId}.originalText`),
      getNullableString(getRecordField(prompt, 'transformedText')),
      getNullableString(getRecordField(prompt, 'promptHeading')),
      getNullableString(getRecordField(prompt, 'type')),
    )

    return {...mapped, [sourcePromptId]: contentHash}
  }, {})
}

const assertPromptPlanHashes = ({
  promptPlan,
  prompts,
}: {
  promptPlan: readonly PromptPlanEntry[]
  prompts: readonly ProjectTransferPayloadRecord[]
}) => {
  const promptHashBySourceId = getPlannedPromptHashBySourceId(prompts)
  const mismatch = promptPlan.find((entry) => {
    return promptHashBySourceId[entry.sourcePromptId] !== entry.computedContentHash
  })

  return mismatch
    ? failCommitWriter(
        `prompt ${mismatch.sourcePromptId} content hash changed after revalidation (${promptHashBySourceId[mismatch.sourcePromptId] ?? 'missing'} !== ${mismatch.computedContentHash})`,
      )
    : undefined
}

const getDuplicateValue = (values: readonly string[]) => {
  const state = values.reduce<{duplicate: string | null; seen: Set<string>}>(
    (current, value) => {
      return current.duplicate
        ? current
        : current.seen.has(value)
          ? {...current, duplicate: value}
          : {duplicate: null, seen: new Set([...current.seen, value])}
    },
    {duplicate: null, seen: new Set()},
  )

  return state.duplicate
}

const assertNoProjectPromptDuplicates = (projectPromptRows: readonly {promptId: string}[]) => {
  const duplicatePromptId = getDuplicateValue(
    projectPromptRows.map((row) => {
      return row.promptId
    }),
  )

  return duplicatePromptId
    ? failCommitWriter(`duplicate project_prompt link after remap for prompt ${duplicatePromptId}`)
    : undefined
}

const getCriteriaDisposition = (value: unknown) => {
  return value === 'include' || value === 'exclude' || value === 'combined' ? value : null
}

const getProjectPromptRows = ({
  projectId,
  projectPromptPlan,
  projectPrompts,
  promptIdBySourceId,
}: {
  projectId: string
  projectPromptPlan: readonly ProjectPromptPlanEntry[]
  projectPrompts: readonly ProjectTransferPayloadRecord[]
  promptIdBySourceId: Record<string, string>
}) => {
  const projectPromptBySourceId = getPayloadArrayBySourceId(projectPrompts, 'sourceProjectPromptId')

  return projectPromptPlan.map((entry) => {
    const projectPrompt = projectPromptBySourceId[entry.sourceProjectPromptId]
    const promptId = promptIdBySourceId[entry.sourcePromptId]

    if (projectPrompt === undefined) {
      return failCommitWriter(`missing project prompt payload ${entry.sourceProjectPromptId}`)
    }

    if (promptId === undefined) {
      return failCommitWriter(`missing target prompt for ${entry.sourcePromptId}`)
    }

    return {
      archived: getBoolean(getRecordField(projectPrompt, 'archived'), entry.metadata.archived === true),
      criteriaDisposition: getCriteriaDisposition(getRecordField(projectPrompt, 'criteriaDisposition')),
      criteriaSectionKey: getNullableString(getRecordField(projectPrompt, 'criteriaSectionKey')),
      criteriaSectionLabel: getNullableString(getRecordField(projectPrompt, 'criteriaSectionLabel')),
      enabled: getBoolean(getRecordField(projectPrompt, 'enabled'), entry.enabled),
      order: getNullableNumber(getRecordField(projectPrompt, 'order')),
      projectId,
      promptId,
    }
  })
}

const insertProjectPromptRows = async (
  tx: ProjectTransferCommitWriterTx,
  rows: readonly ReturnType<typeof getProjectPromptRows>[number][],
) => {
  assertNoProjectPromptDuplicates(rows)

  return rows.length === 0
    ? undefined
    : runChunks(rows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.project_prompt (
          id,
          project_id,
          prompt_id,
          prompt_order,
          archived,
          enabled,
          origin_project_id,
          criteria_disposition,
          criteria_section_key,
          criteria_section_label
        ) VALUES ${rowChunk
          .map((row) => {
            return `(
              ${getSqlLiteral(randomUUID())},
              ${getSqlLiteral(row.projectId)},
              ${getSqlLiteral(row.promptId)},
              ${getSqlLiteral(row.order)},
              ${getSqlLiteral(row.archived)},
              ${getSqlLiteral(row.enabled)},
              NULL,
              ${getSqlLiteral(row.criteriaDisposition)},
              ${getSqlLiteral(row.criteriaSectionKey)},
              ${getSqlLiteral(row.criteriaSectionLabel)}
            )`
          })
          .join(', ')}
      `)
      })
}

const getResolvedArticleIdBySourceId = ({
  articleMatches,
  promotion,
}: {
  articleMatches: readonly ArticleMatchPlan[]
  promotion: ProjectTransferCommitPromotionResult
}) => {
  const createdArticleSources = new Set(
    promotion.articleCreates.map((entry) => {
      return entry.sourceArticleId
    }),
  )

  return articleMatches.reduce<Record<string, string>>((mapped, match) => {
    return match.action === 'create' && createdArticleSources.has(match.sourceArticleId)
      ? {...mapped, [match.sourceArticleId]: randomUUID()}
      : match.action === 'reuse' && match.selectedTargetArticleId !== null
        ? {...mapped, [match.sourceArticleId]: match.selectedTargetArticleId}
        : failCommitWriter(`article ${match.sourceArticleId} is not commit-safe`)
  }, {})
}

const assertNoArticleIdConflicts = async ({
  articles,
  matches,
  tx,
}: {
  articles: readonly ProjectTransferArticlePayloadRecord[]
  matches: readonly ArticleMatchPlan[]
  tx: ProjectTransferCommitWriterTx
}) => {
  const articleBySourceId = getArticleBySourceId(articles)
  const newLegacyIds = matches
    .filter((match) => {
      return match.action === 'create'
    })
    .map((match) => {
      return getNullableString(articleBySourceId[match.sourceArticleId]?.articleId)
    })
    .filter((articleId): articleId is string => {
      return articleId !== null
    })
  const duplicateLegacyId = getDuplicateValue(newLegacyIds)

  if (duplicateLegacyId) {
    return failCommitWriter(`duplicate package article_id after remap: ${duplicateLegacyId}`)
  }

  const existingRows =
    newLegacyIds.length === 0
      ? []
      : await queryChunks<string, {articleId: string; id: string}>(newLegacyIds, (legacyIdChunk) => {
          return tx.queryJson<{articleId: string; id: string}>(`
          SELECT id, article_id AS articleId
          FROM app.article
          WHERE article_id IN (${getQuotedStringList([...legacyIdChunk]).join(', ')})
          ORDER BY article_id ASC, id ASC
        `)
        })
  const conflict = existingRows[0]

  return conflict ? failCommitWriter(`target article_id already exists: ${conflict.articleId}`) : undefined
}

const insertCreatedArticles = async ({
  articleIdBySourceId,
  now,
  promotion,
  tx,
}: {
  articleIdBySourceId: Record<string, string>
  now: Date
  promotion: ProjectTransferCommitPromotionResult
  tx: ProjectTransferCommitWriterTx
}) => {
  return promotion.articleCreates.length === 0
    ? undefined
    : runChunks(promotion.articleCreates, (articleChunk) => {
        return tx.run(`
        INSERT INTO app.article (
          id,
          ${Object.values(articleColumnByPayloadField).join(',\n')},
          created_at,
          updated_at
        ) VALUES ${articleChunk
          .map((entry) => {
            const articleId = articleIdBySourceId[entry.sourceArticleId]

            return articleId === undefined
              ? failCommitWriter(`missing target article id for ${entry.sourceArticleId}`)
              : getCreatedArticleValuesSql({article: entry.article, articleId, now})
          })
          .join(', ')}
      `)
      })
}

const getFillTargetArticleRows = async ({
  promotion,
  tx,
}: {
  promotion: ProjectTransferCommitPromotionResult
  tx: ProjectTransferCommitWriterTx
}) => {
  const targetArticleIds = [
    ...new Set(
      promotion.articleFieldFills.map((fill) => {
        return fill.targetArticleId
      }),
    ),
  ]
  const rows =
    targetArticleIds.length === 0
      ? []
      : await queryChunks<string, TargetArticleFieldRow>(targetArticleIds, (articleIdChunk) => {
          return tx.queryJson<TargetArticleFieldRow>(`
          SELECT
            id,
            ${articleFieldSelectSql}
          FROM app.article
          WHERE id IN (${getQuotedStringList([...articleIdChunk]).join(', ')})
          ORDER BY id ASC
        `)
        })

  return rows.reduce<Record<string, TargetArticleFieldRow>>((mapped, row) => {
    return {...mapped, [row.id]: row}
  }, {})
}

const isMissingTargetArticleValue = (field: ArticleField, value: unknown) => {
  const parsed = articleJsonFields.has(field) || articleArrayFields.has(field) ? getJsonValue(value) : value

  return articleJsonFields.has(field)
    ? parsed === null || parsed === undefined
    : articleArrayFields.has(field)
      ? parsed === null || parsed === undefined || (Array.isArray(parsed) && parsed.length === 0)
      : articleStringFields.has(field)
        ? parsed === null || parsed === undefined || (typeof parsed === 'string' && parsed.trim() === '')
        : parsed === null || parsed === undefined
}

const assertArticleFieldFillsStillMissing = ({
  promotion,
  targetArticleById,
}: {
  promotion: ProjectTransferCommitPromotionResult
  targetArticleById: Record<string, TargetArticleFieldRow>
}) => {
  return promotion.articleFieldFills.map((fill) => {
    const field = fill.field as ArticleField
    const targetArticle = targetArticleById[fill.targetArticleId]

    if (targetArticle === undefined) {
      return failCommitWriter(`target article ${fill.targetArticleId} is missing`)
    }

    return isMissingTargetArticleValue(field, targetArticle[field])
      ? undefined
      : failCommitWriter(`target article ${fill.targetArticleId} field ${field} is no longer missing`)
  })
}

const updateReusedArticles = async ({
  now,
  promotion,
  targetArticleById,
  tx,
}: {
  now: Date
  promotion: ProjectTransferCommitPromotionResult
  targetArticleById: Record<string, TargetArticleFieldRow>
  tx: ProjectTransferCommitWriterTx
}) => {
  const fillsByArticleId = promotion.articleFieldFills.reduce<Record<string, typeof promotion.articleFieldFills>>(
    (mapped, fill) => {
      return {...mapped, [fill.targetArticleId]: [...(mapped[fill.targetArticleId] ?? []), fill]}
    },
    {},
  )

  assertArticleFieldFillsStillMissing({promotion, targetArticleById})

  return Object.entries(fillsByArticleId).reduce<Promise<void>>(async (previous, [articleId, fills]) => {
    await previous
    const setSql = fills
      .map((fill) => {
        const field = fill.field as ArticleField
        const column = articleColumnByPayloadField[field]

        return column === undefined
          ? failCommitWriter(`unsupported article field fill ${fill.field}`)
          : `${column} = ${getArticleFieldSqlLiteral(field, fill.value)}`
      })
      .join(',\n')

    return tx.run(`
      UPDATE app.article
      SET
        ${setSql},
        updated_at = ${getTimestampLiteral(now)}
      WHERE id = ${getSqlLiteral(articleId)}
    `)
  }, Promise.resolve())
}

const insertArticleIdentifiers = async ({
  articleIdBySourceId,
  articles,
  now,
  tx,
}: {
  articleIdBySourceId: Record<string, string>
  articles: readonly ProjectTransferArticlePayloadRecord[]
  now: Date
  tx: ProjectTransferCommitWriterTx
}) => {
  const rows = articles.flatMap((article) => {
    const articleId = articleIdBySourceId[article.sourceArticleId]
    const normalized = getProjectTransferNormalizedArticleIdentifiers(article)

    return articleId === undefined
      ? []
      : normalized.strongIdentifiers.map((identifier, index) => {
          return {articleId, identifier, isPrimary: index === 0, sourceArticleId: article.sourceArticleId}
        })
  })

  return rows.length === 0
    ? undefined
    : runChunks(rows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.article_identifier (
          id,
          article_id,
          kind,
          normalized_value,
          source,
          provenance,
          is_primary,
          created_at,
          updated_at
        ) VALUES ${rowChunk
          .map((row) => {
            return `(
              ${getSqlLiteral(randomUUID())},
              ${getSqlLiteral(row.articleId)},
              ${getSqlLiteral(row.identifier.kind)},
              ${getSqlLiteral(row.identifier.normalizedValue)},
              ${getSqlLiteral(row.identifier.evidence[0]?.source ?? 'project_transfer')},
              ${getJsonLiteral({commit: true, sourceArticleId: row.sourceArticleId})},
              ${getSqlLiteral(row.isPrimary)},
              ${getTimestampLiteral(now)},
              ${getTimestampLiteral(now)}
            )`
          })
          .join(', ')}
        ON CONFLICT(kind, normalized_value) DO NOTHING
      `)
      })
}

const getRouteIdBySourceId = (projectRoutePlan: readonly ProjectRoutePlanEntry[]) => {
  return projectRoutePlan.reduce<Record<string, string>>((mapped, route) => {
    return route.action === 'link' && route.targetImportRouteId !== null
      ? {...mapped, [route.sourceImportRouteId]: route.targetImportRouteId}
      : mapped
  }, {})
}

const assertNoDuplicateRows = (label: string, keys: readonly string[]) => {
  const duplicate = getDuplicateValue([...keys])

  return duplicate ? failCommitWriter(`duplicate ${label} after remap: ${duplicate}`) : undefined
}

const getArticleImportRouteRows = ({
  articleIdBySourceId,
  articleImportRoutes,
  articleRoutePlan,
  routeIdBySourceId,
}: {
  articleIdBySourceId: Record<string, string>
  articleImportRoutes: readonly ProjectTransferPayloadRecord[]
  articleRoutePlan: readonly ArticleRoutePlanEntry[]
  routeIdBySourceId: Record<string, string>
}) => {
  const articleRoutePayloadBySourceId = getPayloadArrayBySourceId(articleImportRoutes, 'sourceArticleImportRouteId')

  return articleRoutePlan
    .filter((entry) => {
      return entry.action === 'write'
    })
    .map((entry) => {
      const payload = articleRoutePayloadBySourceId[entry.sourceArticleImportRouteId]
      const articleId = articleIdBySourceId[entry.sourceArticleId]
      const importRouteId = routeIdBySourceId[entry.sourceImportRouteId]

      if (payload === undefined) {
        return failCommitWriter(`missing article import route payload ${entry.sourceArticleImportRouteId}`)
      }

      if (articleId === undefined || importRouteId === undefined) {
        return failCommitWriter(`article import route ${entry.sourceArticleImportRouteId} is not commit-safe`)
      }

      return {articleId, importRouteId, payload}
    })
}

const assertNoExistingArticleRouteRows = async ({
  rows,
  tx,
}: {
  rows: readonly ReturnType<typeof getArticleImportRouteRows>[number][]
  tx: ProjectTransferCommitWriterTx
}) => {
  const keys = rows.map((row) => {
    return `${row.articleId}\u0000${row.importRouteId}`
  })

  assertNoDuplicateRows('article_import_route', keys)

  const existing =
    rows.length === 0
      ? []
      : await tx.queryJson<{articleId: string; importRouteId: string}>(`
          SELECT air.article_id AS articleId, air.import_route_id AS importRouteId
          FROM app.article_import_route air
          WHERE ${rows
            .map((row) => {
              return `(air.article_id = ${getSqlLiteral(row.articleId)} AND air.import_route_id = ${getSqlLiteral(row.importRouteId)})`
            })
            .join(' OR ')}
          ORDER BY air.article_id ASC, air.import_route_id ASC
        `)
  const conflict = existing[0]

  return conflict
    ? failCommitWriter(
        `target article_import_route already has remapped key ${conflict.articleId}:${conflict.importRouteId}`,
      )
    : undefined
}

const insertArticleImportRoutes = async ({
  rows,
  tx,
}: {
  rows: readonly ReturnType<typeof getArticleImportRouteRows>[number][]
  tx: ProjectTransferCommitWriterTx
}) => {
  await assertNoExistingArticleRouteRows({rows, tx})

  return rows.length === 0
    ? undefined
    : runChunks(rows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.article_import_route (
          id,
          article_id,
          import_route_id,
          external_article_id,
          source_kind,
          import_metadata,
          match_metadata,
          import_run_id,
          source_record_key,
          source_record_hash,
          raw_payload
        ) VALUES ${rowChunk
          .map((row) => {
            return `(
              ${getSqlLiteral(randomUUID())},
              ${getSqlLiteral(row.articleId)},
              ${getSqlLiteral(row.importRouteId)},
              ${getSqlLiteral(getNullableString(getRecordField(row.payload, 'externalArticleId')))},
              ${getSqlLiteral(getNullableString(getRecordField(row.payload, 'sourceKind')))},
              ${getJsonLiteral(getRecordField(row.payload, 'importMetadata'))},
              ${getJsonLiteral(getRecordField(row.payload, 'matchMetadata'))},
              ${getSqlLiteral(getNullableString(getRecordField(row.payload, 'importRunId')))},
              ${getSqlLiteral(getRequiredString(getRecordField(row.payload, 'sourceRecordKey'), 'articleImportRoute.sourceRecordKey'))},
              ${getSqlLiteral(getRequiredString(getRecordField(row.payload, 'sourceRecordHash'), 'articleImportRoute.sourceRecordHash'))},
              ${getJsonLiteral(getRecordField(row.payload, 'rawPayload'))}
            )`
          })
          .join(', ')}
      `)
      })
}

const insertProjectImportRoutes = async ({
  projectId,
  projectRoutePlan,
  tx,
}: {
  projectId: string
  projectRoutePlan: readonly ProjectRoutePlanEntry[]
  tx: ProjectTransferCommitWriterTx
}) => {
  const rows = projectRoutePlan
    .filter((entry) => {
      return entry.action === 'link' && entry.targetImportRouteId !== null
    })
    .map((entry) => {
      return {importRouteId: entry.targetImportRouteId as string, projectId}
    })
  const keys = rows.map((row) => {
    return `${row.projectId}\u0000${row.importRouteId}`
  })

  assertNoDuplicateRows('project_import_route', keys)

  return rows.length === 0
    ? undefined
    : runChunks(rows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.project_import_route (id, project_id, import_route_id)
        VALUES ${rowChunk
          .map((row) => {
            return `(${getSqlLiteral(randomUUID())}, ${getSqlLiteral(row.projectId)}, ${getSqlLiteral(row.importRouteId)})`
          })
          .join(', ')}
      `)
      })
}

const getProjectArticleSourceIds = ({
  articleRoutePlan,
  projectArticles,
}: {
  articleRoutePlan: readonly ArticleRoutePlanEntry[]
  projectArticles: readonly ProjectTransferPayloadRecord[]
}) => {
  const directSources = projectArticles.map((entry) => {
    return getRequiredString(getRecordField(entry, 'sourceArticleId'), 'projectArticle.sourceArticleId')
  })
  const snapshotSources = articleRoutePlan
    .filter((entry) => {
      return entry.snapshotProjectArticleLink
    })
    .map((entry) => {
      return entry.sourceArticleId
    })

  return [...new Set([...directSources, ...snapshotSources])]
}

const insertProjectArticles = async ({
  articleIdBySourceId,
  articleRoutePlan,
  projectArticles,
  projectId,
  tx,
}: {
  articleIdBySourceId: Record<string, string>
  articleRoutePlan: readonly ArticleRoutePlanEntry[]
  projectArticles: readonly ProjectTransferPayloadRecord[]
  projectId: string
  tx: ProjectTransferCommitWriterTx
}) => {
  const rows = getProjectArticleSourceIds({articleRoutePlan, projectArticles}).map((sourceArticleId) => {
    const articleId = articleIdBySourceId[sourceArticleId]

    return articleId === undefined
      ? failCommitWriter(`missing target article id for project article ${sourceArticleId}`)
      : {articleId, projectId}
  })
  const keys = rows.map((row) => {
    return `${row.projectId}\u0000${row.articleId}`
  })

  assertNoDuplicateRows('project_article', keys)

  return rows.length === 0
    ? undefined
    : runChunks(rows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.project_article (id, project_id, article_id, imported_from_project_id)
        VALUES ${rowChunk
          .map((row) => {
            return `(${getSqlLiteral(randomUUID())}, ${getSqlLiteral(row.projectId)}, ${getSqlLiteral(row.articleId)}, NULL)`
          })
          .join(', ')}
      `)
      })
}

const markUpdatedReusedArticlesDirty = async ({
  promotion,
  tx,
}: {
  promotion: ProjectTransferCommitPromotionResult
  tx: ProjectTransferCommitWriterTx
}) => {
  const updatedReusedArticleIds = [
    ...new Set(
      promotion.articleFieldFills.map((fill) => {
        return fill.targetArticleId
      }),
    ),
  ]

  return updatedReusedArticleIds.length === 0
    ? undefined
    : getProjectMartDirtyRefreshStateService().markArticleProjectsDirtyAtomically({
        articleIds: updatedReusedArticleIds,
        reason: 'projectTransferCommit.reusedArticleUpdate',
        runner: tx,
      })
}

const markImportedProjectDirty = async ({projectId, tx}: {projectId: string; tx: ProjectTransferCommitWriterTx}) => {
  await getProjectMartDirtyRefreshStateService().markProjectsDirtyAtomically({
    projects: [{projectId}],
    reason: 'projectTransferCommit.import',
    runner: tx,
  })
}

const getOmittedRouteWarnings = ({
  articleRoutePlan,
  projectRoutePlan,
}: {
  articleRoutePlan: readonly ArticleRoutePlanEntry[]
  projectRoutePlan: readonly ProjectRoutePlanEntry[]
}): ProjectTransferPackageWarning[] => {
  const projectWarnings = projectRoutePlan
    .filter((entry) => {
      return entry.action === 'omit'
    })
    .map((entry): ProjectTransferPackageWarning => {
      return {
        action: 'omitted',
        code: 'targetProjectImportRouteOmitted',
        details: {
          dateBoundedOutsideExportedArticleCount: entry.dateBoundedOutsideExportedArticleCount,
          outsideExportedArticleCount: entry.outsideExportedArticleCount,
          sourceImportRouteId: entry.sourceImportRouteId,
          sourceProjectImportRouteId: entry.sourceProjectImportRouteId,
          targetImportRouteId: entry.targetImportRouteId,
        },
        message: `${entry.sourceProjectImportRouteId} target project import route was omitted`,
        scope: `projectImportRoutes.${entry.sourceProjectImportRouteId}`,
        severity: 'warning',
      }
    })
  const articleWarnings = articleRoutePlan
    .filter((entry) => {
      return entry.action === 'omit'
    })
    .map((entry): ProjectTransferPackageWarning => {
      return {
        action: 'omitted',
        code: 'targetArticleImportRouteOmitted',
        details: {
          sourceArticleId: entry.sourceArticleId,
          sourceArticleImportRouteId: entry.sourceArticleImportRouteId,
          sourceImportRouteId: entry.sourceImportRouteId,
          targetArticleId: entry.targetArticleId,
          targetImportRouteId: entry.targetImportRouteId,
          unsafeProjectIds: entry.unsafeProjectIds,
        },
        message: `${entry.sourceArticleImportRouteId} target article import route was omitted`,
        scope: `articleImportRoutes.${entry.sourceArticleImportRouteId}`,
        severity: 'warning',
      }
    })

  return [...projectWarnings, ...articleWarnings]
}

const getDedupedWarnings = (warnings: readonly ProjectTransferPackageWarning[]) => {
  const result = warnings.reduce<{seen: Set<string>; warnings: ProjectTransferPackageWarning[]}>(
    (current, warning) => {
      const key = getProjectTransferCanonicalJson(warning)

      return current.seen.has(key)
        ? current
        : {seen: new Set([...current.seen, key]), warnings: [...current.warnings, warning]}
    },
    {seen: new Set(), warnings: []},
  )

  return result.warnings
}

const getPlanWarnings = (plan: ProjectTransferImportPlanArtifact) => {
  return getDedupedWarnings([...(plan.packageWarnings ?? []), ...(plan.summary.packageWarnings ?? [])])
}

const getEquivalentReusedJudgmentWarnings = (
  judgmentPlan: readonly JudgmentPlanEntry[],
): ProjectTransferPackageWarning[] => {
  return judgmentPlan
    .filter((entry) => {
      return entry.action === 'reuse' && entry.targetJudgmentId !== null
    })
    .map((entry): ProjectTransferPackageWarning => {
      return {
        action: 'reused',
        code: 'equivalentTargetJudgmentReused',
        details: {
          inputSignatureProvenance: entry.provenanceKind,
          physicalKey: entry.physicalKey,
          reviewVisibleKey: entry.reviewVisibleKey,
          sourceJudgmentId: entry.sourceJudgmentId,
          targetJudgmentId: entry.targetJudgmentId,
        },
        message: `${entry.sourceJudgmentId} reused equivalent target judgment ${entry.targetJudgmentId}`,
        scope: `judgments.${entry.sourceJudgmentId}`,
        severity: 'info',
      }
    })
}

const getCommitImportWarnings = ({
  articleRoutePlan,
  judgmentPlan,
  plan,
  projectRoutePlan,
}: {
  articleRoutePlan: readonly ArticleRoutePlanEntry[]
  judgmentPlan: readonly JudgmentPlanEntry[]
  plan: ProjectTransferImportPlanArtifact
  projectRoutePlan: readonly ProjectRoutePlanEntry[]
}) => {
  return getDedupedWarnings([
    ...getPlanWarnings(plan),
    ...getOmittedRouteWarnings({articleRoutePlan, projectRoutePlan}),
    ...getEquivalentReusedJudgmentWarnings(judgmentPlan),
  ])
}

const getPayloadCounts = (plan: ProjectTransferImportPlanArtifact): Record<ProjectTransferPayloadKey, number> => {
  return plan.packageCounts
}

const getFinalCounts = ({
  articleIdBySourceId,
  humanJudgmentRows,
  humanSummaryRows,
  importWarnings,
  judgmentAssessmentRows,
  judgmentIdBySourceId,
  promptIdBySourceId,
  reviewRows,
  routeIdBySourceId,
}: {
  articleIdBySourceId: Record<string, string>
  humanJudgmentRows: readonly HumanJudgmentCommitRow[]
  humanSummaryRows: readonly HumanJudgmentSummaryCommitRow[]
  importWarnings: readonly ProjectTransferPackageWarning[]
  judgmentAssessmentRows: readonly JudgmentAssessmentCommitRow[]
  judgmentIdBySourceId: Record<string, string>
  promptIdBySourceId: Record<string, string>
  reviewRows: readonly ReviewCommitRow[]
  routeIdBySourceId: Record<string, string>
}) => {
  return {
    articles: Object.keys(articleIdBySourceId).length,
    humanJudgmentSummaries: humanSummaryRows.length,
    humanJudgments: humanJudgmentRows.length,
    judgmentAssessments: judgmentAssessmentRows.length,
    judgments: Object.keys(judgmentIdBySourceId).length,
    prompts: Object.keys(promptIdBySourceId).length,
    reviews: reviewRows.length,
    routes: Object.keys(routeIdBySourceId).length,
    warnings: importWarnings.length,
  }
}

const getCompletionPayload = ({
  finalCounts,
  importWarnings,
  packageFingerprint,
  payloadCounts,
  projectId,
  projectName,
  transferHistoryId,
}: {
  finalCounts: Record<string, number>
  importWarnings: ProjectTransferPackageWarning[]
  packageFingerprint: string
  payloadCounts: Record<string, number>
  projectId: string
  projectName: string
  transferHistoryId: string
}): ProjectTransferImportCompletionPayload => {
  return {
    finalCounts,
    importWarnings,
    packageFingerprint,
    payloadCounts,
    projectId,
    projectName,
    status: 'completed',
    targetProjectId: projectId,
    targetProjectName: projectName,
    transferHistoryId,
  }
}

const getRequiredPlanEntries = <TEntry>(
  entries: readonly TEntry[] | undefined,
  label: string,
  payloadCount: number,
) => {
  return payloadCount === 0 ? (entries ?? []) : (entries ?? failCommitWriter(`${label} is required`))
}

const getContentSettings = (record: ProjectTransferPayloadRecord) => {
  const settings = isRecord(record.contentSettings) ? record.contentSettings : {}

  return {
    useAbstract: getBoolean(settings.useAbstract, true),
    useFulltext: getBoolean(settings.useFulltext, false),
    useFulltextNoImages: getBoolean(settings.useFulltextNoImages, false),
    useTitle: getBoolean(settings.useTitle, true),
  }
}

const getMappedTargetId = ({
  label,
  mapped,
  sourceId,
}: {
  label: string
  mapped: Record<string, string>
  sourceId: string
}) => {
  return mapped[sourceId] ?? failCommitWriter(`missing target ${label} for ${sourceId}`)
}

const getTargetModelIdForSource = ({
  plan,
  sourceModelId,
}: {
  plan: ProjectTransferImportPlanArtifact
  sourceModelId: string
}) => {
  return (
    getDependencyResolutionState(plan).modelTargetBySourceId?.[sourceModelId]
    ?? failCommitWriter(`missing target model for ${sourceModelId}`)
  )
}

const assertPlanTargetMatches = ({actual, label, planned}: {actual: string; label: string; planned: string | null}) => {
  return planned === null || planned.startsWith('new:') || planned === actual
    ? undefined
    : failCommitWriter(`${label} plan target ${planned} does not match final target ${actual}`)
}

const getJudgmentPhysicalKey = (row: {
  articleId: string
  deleteGeneration: number
  modelId: string
  promptId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}) => {
  return [
    row.articleId,
    row.promptId,
    row.modelId,
    String(row.useTitle),
    String(row.useAbstract),
    String(row.useFulltext),
    String(row.useFulltextNoImages),
    String(row.deleteGeneration),
  ].join('\u0000')
}

const getJudgmentReviewVisibleKey = (row: {
  articleId: string
  modelId: string
  promptId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}) => {
  return [
    row.articleId,
    row.promptId,
    row.modelId,
    String(row.useTitle),
    String(row.useAbstract),
    String(row.useFulltext),
    String(row.useFulltextNoImages),
  ].join('\u0000')
}

const getTargetJudgmentPhysicalKey = (row: TargetJudgmentRow) => {
  return getJudgmentPhysicalKey({
    articleId: row.articleId,
    deleteGeneration: row.deleteGeneration ?? 0,
    modelId: row.modelId,
    promptId: row.promptId,
    useAbstract: row.useAbstract,
    useFulltext: row.useFulltext,
    useFulltextNoImages: row.useFulltextNoImages,
    useTitle: row.useTitle,
  })
}

const getTargetJudgmentReviewVisibleKey = (row: TargetJudgmentRow) => {
  return getJudgmentReviewVisibleKey(row)
}

const getJudgmentFieldSignature = (row: JudgmentCommitRow) => {
  return {
    answeredOriginal: row.answeredOriginal,
    answeredOriginalAsArray: row.answeredOriginalAsArray,
    confidenceOriginal: row.confidenceOriginal,
    explanation: row.explanation,
    isAnswered: true,
    quotes: row.quotes,
  }
}

const getTargetJudgmentFieldSignature = (row: TargetJudgmentRow) => {
  return {
    answeredOriginal: row.answeredOriginal,
    answeredOriginalAsArray: getArrayValue(row.answeredOriginalAsArray),
    confidenceOriginal: row.confidenceOriginal ?? 50,
    explanation: row.explanation,
    isAnswered: row.isAnswered ?? false,
    quotes: getArrayValue(row.quotes),
  }
}

const getJudgmentRows = ({
  articleIdBySourceId,
  judgmentPlan,
  judgments,
  now,
  plan,
  promptIdBySourceId,
}: {
  articleIdBySourceId: Record<string, string>
  judgmentPlan: readonly JudgmentPlanEntry[]
  judgments: readonly ProjectTransferPayloadRecord[]
  now: Date
  plan: ProjectTransferImportPlanArtifact
  promptIdBySourceId: Record<string, string>
}) => {
  const planBySourceId = judgmentPlan.reduce<Record<string, JudgmentPlanEntry>>((mapped, entry) => {
    return {...mapped, [entry.sourceJudgmentId]: entry}
  }, {})
  const judgmentBySourceId = getPayloadArrayBySourceId(judgments, 'sourceJudgmentId')
  const extraPlanEntry = judgmentPlan.find((entry) => {
    return judgmentBySourceId[entry.sourceJudgmentId] === undefined
  })

  if (extraPlanEntry) {
    return failCommitWriter(`judgment plan references missing payload ${extraPlanEntry.sourceJudgmentId}`)
  }

  return judgments.map((judgment): JudgmentCommitRow => {
    const sourceJudgmentId = getRequiredString(
      getRecordField(judgment, 'sourceJudgmentId'),
      'judgment.sourceJudgmentId',
    )
    const sourceArticleId = getRequiredString(
      getRecordField(judgment, 'sourceArticleId'),
      `judgments.${sourceJudgmentId}.sourceArticleId`,
    )
    const sourcePromptId = getRequiredString(
      getRecordField(judgment, 'sourcePromptId'),
      `judgments.${sourceJudgmentId}.sourcePromptId`,
    )
    const sourceModelId = getRequiredString(
      getRecordField(judgment, 'sourceModelId'),
      `judgments.${sourceJudgmentId}.sourceModelId`,
    )
    const entry = planBySourceId[sourceJudgmentId] ?? failCommitWriter(`missing judgment plan for ${sourceJudgmentId}`)
    const action =
      entry.action === 'insert' || entry.action === 'reuse'
        ? entry.action
        : failCommitWriter(`judgment ${sourceJudgmentId} is not commit-safe`)
    const articleId = getMappedTargetId({label: 'article', mapped: articleIdBySourceId, sourceId: sourceArticleId})
    const promptId = getMappedTargetId({label: 'prompt', mapped: promptIdBySourceId, sourceId: sourcePromptId})
    const modelId = getTargetModelIdForSource({plan, sourceModelId})
    const settings = getContentSettings(judgment)

    assertPlanTargetMatches({
      actual: articleId,
      label: `judgment ${sourceJudgmentId} article`,
      planned: entry.targetArticleId,
    })
    assertPlanTargetMatches({
      actual: promptId,
      label: `judgment ${sourceJudgmentId} prompt`,
      planned: entry.targetPromptId,
    })
    assertPlanTargetMatches({
      actual: modelId,
      label: `judgment ${sourceJudgmentId} model`,
      planned: entry.targetModelId,
    })

    if (getRecordField(judgment, 'isAnswered') !== true) {
      return failCommitWriter(`judgment ${sourceJudgmentId} is not answered`)
    }

    return {
      action,
      answeredOriginal: getNullableString(getRecordField(judgment, 'answeredOriginal')),
      answeredOriginalAsArray: getStringArray(getRecordField(judgment, 'answeredOriginalAsArray')) ?? [],
      articleId,
      chunkingStrategy: getNullableString(getRecordField(judgment, 'chunkingStrategy')),
      confidenceOriginal: getNonNegativeInteger(getRecordField(judgment, 'confidenceOriginal'), 50),
      createdAt: getDateOrDefault(getRecordField(judgment, 'createdAt'), now),
      deleteGeneration: getNonNegativeInteger(getRecordField(judgment, 'deleteGeneration'), 0),
      explanation: getNullableString(getRecordField(judgment, 'explanation')),
      id:
        action === 'insert'
          ? randomUUID()
          : (entry.targetJudgmentId ?? failCommitWriter(`reused judgment ${sourceJudgmentId} has no target id`)),
      modelId,
      promptId,
      quotes: getArrayValue(getRecordField(judgment, 'quotes')),
      snapshotProjectModelName: getNullableString(getRecordField(judgment, 'snapshotProjectModelName')),
      sourceJudgmentId,
      updatedAt: getDateOrDefault(getRecordField(judgment, 'updatedAt'), now),
      ...settings,
    }
  })
}

const getTargetJudgmentRows = async ({
  rows,
  tx,
}: {
  rows: readonly JudgmentCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  const articleIds = [
    ...new Set(
      rows.map((row) => {
        return row.articleId
      }),
    ),
  ]
  const promptIds = [
    ...new Set(
      rows.map((row) => {
        return row.promptId
      }),
    ),
  ]
  const modelIds = [
    ...new Set(
      rows.map((row) => {
        return row.modelId
      }),
    ),
  ]

  return rows.length === 0
    ? []
    : getValueChunks(articleIds).reduce<Promise<TargetJudgmentRow[]>>(async (articleRowsPromise, articleIdChunk) => {
        const articleRows = await articleRowsPromise
        const promptRows = await getValueChunks(promptIds).reduce<Promise<TargetJudgmentRow[]>>(
          async (promptRowsPromise, promptIdChunk) => {
            const currentPromptRows = await promptRowsPromise
            const modelRows = await queryChunks<string, TargetJudgmentRow>(modelIds, (modelIdChunk) => {
              return tx.queryJson<TargetJudgmentRow>(`
                SELECT
                  id,
                  article_id AS articleId,
                  prompt_id AS promptId,
                  model_id AS modelId,
                  use_title AS useTitle,
                  use_abstract AS useAbstract,
                  use_fulltext AS useFulltext,
                  use_fulltext_no_images AS useFulltextNoImages,
                  is_answered AS isAnswered,
                  answered_original AS answeredOriginal,
                  TO_JSON(answered_original_as_array) AS answeredOriginalAsArray,
                  confidence_original AS confidenceOriginal,
                  explanation,
                  TO_JSON(quotes) AS quotes,
                  delete_generation AS deleteGeneration
                FROM app.judgment
                WHERE deleted_at IS NULL
                  AND article_id IN (${getQuotedStringList([...articleIdChunk]).join(', ')})
                  AND prompt_id IN (${getQuotedStringList([...promptIdChunk]).join(', ')})
                  AND model_id IN (${getQuotedStringList([...modelIdChunk]).join(', ')})
                ORDER BY article_id ASC, prompt_id ASC, model_id ASC, id ASC
              `)
            })

            return [...currentPromptRows, ...modelRows]
          },
          Promise.resolve([]),
        )

        return [...articleRows, ...promptRows]
      }, Promise.resolve([]))
}

const assertNoDuplicateJudgmentRows = (rows: readonly JudgmentCommitRow[]) => {
  assertNoDuplicateRows(
    'judgment physical key',
    rows.map((row) => {
      return getJudgmentPhysicalKey(row)
    }),
  )

  return assertNoDuplicateRows(
    'judgment active review-visible key',
    rows.map((row) => {
      return getJudgmentReviewVisibleKey(row)
    }),
  )
}

const assertJudgmentTargetsCommitSafe = async ({
  rows,
  tx,
}: {
  rows: readonly JudgmentCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  assertNoDuplicateJudgmentRows(rows)

  const targets = await getTargetJudgmentRows({rows, tx})
  const targetsByPhysicalKey = targets.reduce<Record<string, TargetJudgmentRow[]>>((mapped, target) => {
    const key = getTargetJudgmentPhysicalKey(target)

    return {...mapped, [key]: [...(mapped[key] ?? []), target]}
  }, {})
  const targetsByVisibleKey = targets.reduce<Record<string, TargetJudgmentRow[]>>((mapped, target) => {
    const key = getTargetJudgmentReviewVisibleKey(target)

    return {...mapped, [key]: [...(mapped[key] ?? []), target]}
  }, {})

  return rows.map((row) => {
    const physicalKey = getJudgmentPhysicalKey(row)
    const visibleKey = getJudgmentReviewVisibleKey(row)
    const physicalTargets = targetsByPhysicalKey[physicalKey] ?? []
    const visibleTargets = targetsByVisibleKey[visibleKey] ?? []
    const target = physicalTargets.find((targetRow) => {
      return targetRow.id === row.id
    })
    const extraVisibleTarget = visibleTargets.find((targetRow) => {
      return targetRow.id !== row.id
    })

    if (row.action === 'insert' && physicalTargets.length > 0) {
      return failCommitWriter(`target judgment physical key already exists for ${row.sourceJudgmentId}`)
    }

    if (row.action === 'insert' && visibleTargets.length > 0) {
      return failCommitWriter(`target judgment review-visible key already exists for ${row.sourceJudgmentId}`)
    }

    if (row.action === 'reuse' && target === undefined) {
      return failCommitWriter(
        `reused target judgment ${row.id} is missing or no longer matches ${row.sourceJudgmentId}`,
      )
    }

    if (row.action === 'reuse' && extraVisibleTarget !== undefined) {
      return failCommitWriter(`reused judgment ${row.sourceJudgmentId} has an active review-visible conflict`)
    }

    return row.action === 'reuse'
      && target !== undefined
      && !valuesEquivalent(getJudgmentFieldSignature(row), getTargetJudgmentFieldSignature(target))
      ? failCommitWriter(`reused target judgment ${row.id} is not equivalent to ${row.sourceJudgmentId}`)
      : undefined
  })
}

const insertJudgmentRows = async ({
  projectId,
  rows,
  tx,
}: {
  projectId: string
  rows: readonly JudgmentCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  await assertJudgmentTargetsCommitSafe({rows, tx})

  const insertRows = rows.filter((row) => {
    return row.action === 'insert'
  })

  return insertRows.length === 0
    ? undefined
    : runChunks(insertRows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.judgment (
          id,
          article_id,
          prompt_id,
          model_id,
          project_id,
          snapshot_project_id,
          snapshot_project_model_name,
          use_title,
          use_abstract,
          use_fulltext,
          use_fulltext_no_images,
          chunking_strategy,
          is_answered,
          answered_original,
          answered_original_as_array,
          confidence_original,
          explanation,
          quotes,
          delete_generation,
          deleted_at,
          created_at,
          updated_at
        ) VALUES ${rowChunk
          .map((row) => {
            return `(
              ${getSqlLiteral(row.id)},
              ${getSqlLiteral(row.articleId)},
              ${getSqlLiteral(row.promptId)},
              ${getSqlLiteral(row.modelId)},
              ${getSqlLiteral(projectId)},
              ${getSqlLiteral(projectId)},
              ${getSqlLiteral(row.snapshotProjectModelName)},
              ${getSqlLiteral(row.useTitle)},
              ${getSqlLiteral(row.useAbstract)},
              ${getSqlLiteral(row.useFulltext)},
              ${getSqlLiteral(row.useFulltextNoImages)},
              ${getSqlLiteral(row.chunkingStrategy)},
              TRUE,
              ${getSqlLiteral(row.answeredOriginal)},
              ${getSqlLiteral(row.answeredOriginalAsArray)},
              ${getSqlLiteral(row.confidenceOriginal)},
              ${getSqlLiteral(row.explanation)},
              ${getJsonLiteral(row.quotes)},
              ${getSqlLiteral(row.deleteGeneration)},
              NULL,
              ${getTimestampLiteral(row.createdAt)},
              ${getTimestampLiteral(row.updatedAt)}
            )`
          })
          .join(', ')}
      `)
      })
}

const getJudgmentIdBySourceId = (rows: readonly JudgmentCommitRow[]) => {
  return rows.reduce<Record<string, string>>((mapped, row) => {
    return {...mapped, [row.sourceJudgmentId]: row.id}
  }, {})
}

const getAssessmentSignature = (
  row: Pick<JudgmentAssessmentCommitRow, 'assessmentComment' | 'assessmentIsCorrect'>,
) => {
  return {assessmentComment: row.assessmentComment, assessmentIsCorrect: row.assessmentIsCorrect}
}

const getTargetAssessmentSignature = (row: TargetJudgmentAssessmentRow) => {
  return {assessmentComment: row.assessmentComment, assessmentIsCorrect: row.assessmentIsCorrect ?? false}
}

const getJudgmentAssessmentRows = ({
  assessmentPlan,
  assessments,
  judgmentIdBySourceId,
  now,
}: {
  assessmentPlan: readonly JudgmentAssessmentPlanEntry[]
  assessments: readonly ProjectTransferPayloadRecord[]
  judgmentIdBySourceId: Record<string, string>
  now: Date
}) => {
  const planBySourceId = assessmentPlan.reduce<Record<string, JudgmentAssessmentPlanEntry>>((mapped, entry) => {
    return {...mapped, [entry.sourceJudgmentAssessmentId]: entry}
  }, {})
  const assessmentBySourceId = getPayloadArrayBySourceId(assessments, 'sourceJudgmentAssessmentId')
  const extraPlanEntry = assessmentPlan.find((entry) => {
    return assessmentBySourceId[entry.sourceJudgmentAssessmentId] === undefined
  })

  if (extraPlanEntry) {
    return failCommitWriter(
      `judgment assessment plan references missing payload ${extraPlanEntry.sourceJudgmentAssessmentId}`,
    )
  }

  return assessments.map((assessment): JudgmentAssessmentCommitRow => {
    const sourceJudgmentAssessmentId = getRequiredString(
      getRecordField(assessment, 'sourceJudgmentAssessmentId'),
      'judgmentAssessment.sourceJudgmentAssessmentId',
    )
    const sourceJudgmentId = getRequiredString(
      getRecordField(assessment, 'sourceJudgmentId'),
      `judgmentAssessments.${sourceJudgmentAssessmentId}.sourceJudgmentId`,
    )
    const entry =
      planBySourceId[sourceJudgmentAssessmentId]
      ?? failCommitWriter(`missing judgment assessment plan for ${sourceJudgmentAssessmentId}`)
    const action =
      entry.action === 'insert' || entry.action === 'reuse'
        ? entry.action
        : failCommitWriter(`judgment assessment ${sourceJudgmentAssessmentId} is not commit-safe`)
    const judgmentId =
      judgmentIdBySourceId[sourceJudgmentId]
      ?? failCommitWriter(`missing target judgment for assessment ${sourceJudgmentAssessmentId}`)

    assertPlanTargetMatches({
      actual: judgmentId,
      label: `judgment assessment ${sourceJudgmentAssessmentId}`,
      planned: entry.targetJudgmentId,
    })

    return {
      action,
      assessmentComment: getNullableString(getRecordField(assessment, 'assessmentComment')),
      assessmentIsCorrect: getBoolean(getRecordField(assessment, 'assessmentIsCorrect'), false),
      createdAt: getDateOrDefault(getRecordField(assessment, 'createdAt'), now),
      id:
        action === 'insert'
          ? randomUUID()
          : (entry.targetAssessmentId
            ?? failCommitWriter(`reused assessment ${sourceJudgmentAssessmentId} has no target id`)),
      judgmentId,
      sourceJudgmentAssessmentId,
      updatedAt: getDateOrDefault(getRecordField(assessment, 'updatedAt'), now),
    }
  })
}

const getTargetAssessmentRows = async ({
  judgmentIds,
  tx,
}: {
  judgmentIds: readonly string[]
  tx: ProjectTransferCommitWriterTx
}) => {
  const uniqueJudgmentIds = [...new Set(judgmentIds)]

  return uniqueJudgmentIds.length === 0
    ? []
    : queryChunks<string, TargetJudgmentAssessmentRow>(uniqueJudgmentIds, (judgmentIdChunk) => {
        return tx.queryJson<TargetJudgmentAssessmentRow>(`
        SELECT
          id,
          judgment_id AS judgmentId,
          assessment_is_correct AS assessmentIsCorrect,
          assessment_comment AS assessmentComment
        FROM app.judgment_assessment
        WHERE judgment_id IN (${getQuotedStringList([...judgmentIdChunk]).join(', ')})
        ORDER BY judgment_id ASC, id ASC
      `)
      })
}

const assertJudgmentAssessmentTargetsCommitSafe = async ({
  allJudgmentIds,
  rows,
  tx,
}: {
  allJudgmentIds: readonly string[]
  rows: readonly JudgmentAssessmentCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  assertNoDuplicateRows(
    'judgment_assessment',
    rows.map((row) => {
      return row.judgmentId
    }),
  )

  const targets = await getTargetAssessmentRows({judgmentIds: allJudgmentIds, tx})
  const targetByJudgmentId = targets.reduce<Record<string, TargetJudgmentAssessmentRow>>((mapped, target) => {
    return {...mapped, [target.judgmentId]: target}
  }, {})
  const packageJudgmentIds = new Set(
    rows.map((row) => {
      return row.judgmentId
    }),
  )
  const extraTarget = targets.find((target) => {
    return !packageJudgmentIds.has(target.judgmentId)
  })

  if (extraTarget) {
    return failCommitWriter(`target judgment ${extraTarget.judgmentId} has assessment state missing from package`)
  }

  return rows.map((row) => {
    const target = targetByJudgmentId[row.judgmentId] ?? null

    if (row.action === 'insert' && target !== null) {
      return failCommitWriter(`target judgment ${row.judgmentId} already has assessment state`)
    }

    if (row.action === 'reuse' && target === null) {
      return failCommitWriter(`reused assessment ${row.id} is missing for ${row.sourceJudgmentAssessmentId}`)
    }

    if (row.action === 'reuse' && target !== null && target.id !== row.id) {
      return failCommitWriter(`reused assessment ${row.id} no longer points at ${row.judgmentId}`)
    }

    return row.action === 'reuse'
      && target !== null
      && !valuesEquivalent(getAssessmentSignature(row), getTargetAssessmentSignature(target))
      ? failCommitWriter(`reused assessment ${row.id} is not equivalent to ${row.sourceJudgmentAssessmentId}`)
      : undefined
  })
}

const insertJudgmentAssessmentRows = async ({
  allJudgmentIds,
  rows,
  tx,
}: {
  allJudgmentIds: readonly string[]
  rows: readonly JudgmentAssessmentCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  await assertJudgmentAssessmentTargetsCommitSafe({allJudgmentIds, rows, tx})

  const insertRows = rows.filter((row) => {
    return row.action === 'insert'
  })

  return insertRows.length === 0
    ? undefined
    : runChunks(insertRows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.judgment_assessment (
          id,
          judgment_id,
          assessment_is_correct,
          assessment_comment,
          created_at,
          updated_at
        ) VALUES ${rowChunk
          .map((row) => {
            return `(
              ${getSqlLiteral(row.id)},
              ${getSqlLiteral(row.judgmentId)},
              ${getSqlLiteral(row.assessmentIsCorrect)},
              ${getSqlLiteral(row.assessmentComment)},
              ${getTimestampLiteral(row.createdAt)},
              ${getTimestampLiteral(row.updatedAt)}
            )`
          })
          .join(', ')}
      `)
      })
}

const getHumanReviewPlanByKey = (humanReviewPlan: readonly HumanReviewPlanEntry[]) => {
  return humanReviewPlan.reduce<Record<string, HumanReviewPlanEntry>>((mapped, entry) => {
    return {...mapped, [`${entry.kind}\u0000${entry.sourceId}`]: entry}
  }, {})
}

const assertHumanReviewPlanEntry = ({
  entry,
  kind,
  sourceId,
}: {
  entry: HumanReviewPlanEntry | undefined
  kind: HumanReviewPlanEntry['kind']
  sourceId: string
}) => {
  return entry === undefined
    ? failCommitWriter(`missing ${kind} plan for ${sourceId}`)
    : entry.action === 'insert'
      ? entry
      : failCommitWriter(`${kind} ${sourceId} is not commit-safe`)
}

const getHumanJudgmentRows = ({
  articleIdBySourceId,
  humanJudgments,
  humanReviewPlan,
  now,
  projectId,
  promptIdBySourceId,
}: {
  articleIdBySourceId: Record<string, string>
  humanJudgments: readonly ProjectTransferPayloadRecord[]
  humanReviewPlan: readonly HumanReviewPlanEntry[]
  now: Date
  projectId: string
  promptIdBySourceId: Record<string, string>
}) => {
  const planByKey = getHumanReviewPlanByKey(humanReviewPlan)

  return humanJudgments.map((judgment): HumanJudgmentCommitRow => {
    const sourceHumanJudgmentId = getRequiredString(
      getRecordField(judgment, 'sourceHumanJudgmentId'),
      'humanJudgment.sourceHumanJudgmentId',
    )
    const sourceArticleId = getRequiredString(
      getRecordField(judgment, 'sourceArticleId'),
      `humanJudgments.${sourceHumanJudgmentId}.sourceArticleId`,
    )
    const sourcePromptId = getRequiredString(
      getRecordField(judgment, 'sourcePromptId'),
      `humanJudgments.${sourceHumanJudgmentId}.sourcePromptId`,
    )
    const entry = assertHumanReviewPlanEntry({
      entry: planByKey[`humanJudgment\u0000${sourceHumanJudgmentId}`],
      kind: 'humanJudgment',
      sourceId: sourceHumanJudgmentId,
    })
    const articleId = getMappedTargetId({label: 'article', mapped: articleIdBySourceId, sourceId: sourceArticleId})
    const promptId = getMappedTargetId({label: 'prompt', mapped: promptIdBySourceId, sourceId: sourcePromptId})

    assertPlanTargetMatches({
      actual: articleId,
      label: `human judgment ${sourceHumanJudgmentId} article`,
      planned: entry.targetArticleId,
    })
    assertPlanTargetMatches({
      actual: promptId,
      label: `human judgment ${sourceHumanJudgmentId} prompt`,
      planned: entry.targetPromptId,
    })

    return {
      answer: getNullableString(getRecordField(judgment, 'answer')),
      articleId,
      comment: getNullableString(getRecordField(judgment, 'comment')),
      createdAt: getDateOrDefault(getRecordField(judgment, 'createdAt'), now),
      id: randomUUID(),
      isAnswered: getBoolean(getRecordField(judgment, 'isAnswered'), false),
      projectId,
      promptId,
      sourceHumanJudgmentId,
      updatedAt: getDateOrDefault(getRecordField(judgment, 'updatedAt'), now),
    }
  })
}

const getHumanJudgmentSummaryRows = ({
  articleIdBySourceId,
  humanReviewPlan,
  humanSummaries,
  now,
  projectId,
}: {
  articleIdBySourceId: Record<string, string>
  humanReviewPlan: readonly HumanReviewPlanEntry[]
  humanSummaries: readonly ProjectTransferPayloadRecord[]
  now: Date
  projectId: string
}) => {
  const planByKey = getHumanReviewPlanByKey(humanReviewPlan)

  return humanSummaries.map((summary): HumanJudgmentSummaryCommitRow => {
    const sourceHumanJudgmentSummaryId = getRequiredString(
      getRecordField(summary, 'sourceHumanJudgmentSummaryId'),
      'humanJudgmentSummary.sourceHumanJudgmentSummaryId',
    )
    const sourceArticleId = getRequiredString(
      getRecordField(summary, 'sourceArticleId'),
      `humanJudgmentSummaries.${sourceHumanJudgmentSummaryId}.sourceArticleId`,
    )
    const entry = assertHumanReviewPlanEntry({
      entry: planByKey[`humanJudgmentSummary\u0000${sourceHumanJudgmentSummaryId}`],
      kind: 'humanJudgmentSummary',
      sourceId: sourceHumanJudgmentSummaryId,
    })
    const articleId = getMappedTargetId({label: 'article', mapped: articleIdBySourceId, sourceId: sourceArticleId})

    assertPlanTargetMatches({
      actual: articleId,
      label: `human summary ${sourceHumanJudgmentSummaryId} article`,
      planned: entry.targetArticleId,
    })

    return {
      answer: getNullableString(getRecordField(summary, 'answer')),
      articleId,
      createdAt: getDateOrDefault(getRecordField(summary, 'createdAt'), now),
      id: randomUUID(),
      origin: getRequiredString(
        getRecordField(summary, 'origin'),
        `humanJudgmentSummaries.${sourceHumanJudgmentSummaryId}.origin`,
      ),
      projectId,
      sourceHumanJudgmentSummaryId,
      updatedAt: getDateOrDefault(getRecordField(summary, 'updatedAt'), now),
    }
  })
}

const reviewSectionNames = [
  'title',
  'abstract',
  'intro',
  'method',
  'results',
  'discussion',
  'conclusion',
  'appendix',
  'other',
] as const

const getReviewSections = (value: unknown) => {
  const sections = isRecord(value) ? value : {}

  return reviewSectionNames.reduce<Record<string, {comment: string | null; reviewed: boolean}>>((mapped, section) => {
    const sectionValue = getRecordField(sections, section)
    const sectionRecord = isRecord(sectionValue) ? sectionValue : {}

    return {
      ...mapped,
      [section]: {
        comment: getNullableString(getRecordField(sectionRecord, 'comment')),
        reviewed: getBoolean(getRecordField(sectionRecord, 'reviewed'), false),
      },
    }
  }, {})
}

const getReviewRows = ({
  articleIdBySourceId,
  humanReviewPlan,
  now,
  projectId,
  reviews,
}: {
  articleIdBySourceId: Record<string, string>
  humanReviewPlan: readonly HumanReviewPlanEntry[]
  now: Date
  projectId: string
  reviews: readonly ProjectTransferPayloadRecord[]
}) => {
  const planByKey = getHumanReviewPlanByKey(humanReviewPlan)

  return reviews.map((review): ReviewCommitRow => {
    const sourceReviewId = getRequiredString(getRecordField(review, 'sourceReviewId'), 'review.sourceReviewId')
    const sourceArticleId = getRequiredString(
      getRecordField(review, 'sourceArticleId'),
      `reviews.${sourceReviewId}.sourceArticleId`,
    )
    const entry = assertHumanReviewPlanEntry({
      entry: planByKey[`review\u0000${sourceReviewId}`],
      kind: 'review',
      sourceId: sourceReviewId,
    })
    const articleId = getMappedTargetId({label: 'article', mapped: articleIdBySourceId, sourceId: sourceArticleId})

    assertPlanTargetMatches({
      actual: articleId,
      label: `review ${sourceReviewId} article`,
      planned: entry.targetArticleId,
    })

    return {
      articleId,
      createdAt: getDateOrDefault(getRecordField(review, 'createdAt'), now),
      id: randomUUID(),
      opened: getBoolean(getRecordField(review, 'opened'), false),
      projectId,
      sections: getReviewSections(getRecordField(review, 'sections')),
      sourceReviewId,
      updatedAt: getDateOrDefault(getRecordField(review, 'updatedAt'), now),
    }
  })
}

const assertNoHumanReviewPlanExtras = ({
  humanReviewPlan,
  humanJudgments,
  humanSummaries,
  reviews,
}: {
  humanJudgments: readonly ProjectTransferPayloadRecord[]
  humanReviewPlan: readonly HumanReviewPlanEntry[]
  humanSummaries: readonly ProjectTransferPayloadRecord[]
  reviews: readonly ProjectTransferPayloadRecord[]
}) => {
  const payloadKeys = new Set([
    ...humanJudgments.map((record) => {
      return `humanJudgment\u0000${getRequiredString(getRecordField(record, 'sourceHumanJudgmentId'), 'humanJudgment.sourceHumanJudgmentId')}`
    }),
    ...humanSummaries.map((record) => {
      return `humanJudgmentSummary\u0000${getRequiredString(getRecordField(record, 'sourceHumanJudgmentSummaryId'), 'humanJudgmentSummary.sourceHumanJudgmentSummaryId')}`
    }),
    ...reviews.map((record) => {
      return `review\u0000${getRequiredString(getRecordField(record, 'sourceReviewId'), 'review.sourceReviewId')}`
    }),
  ])
  const extraEntry = humanReviewPlan.find((entry) => {
    return !payloadKeys.has(`${entry.kind}\u0000${entry.sourceId}`)
  })

  return extraEntry
    ? failCommitWriter(`${extraEntry.kind} plan references missing payload ${extraEntry.sourceId}`)
    : undefined
}

const assertNoExistingHumanJudgments = async ({
  rows,
  tx,
}: {
  rows: readonly HumanJudgmentCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  const keys = rows.map((row) => {
    return `${row.projectId}\u0000${row.articleId}\u0000${row.promptId}`
  })

  assertNoDuplicateRows('judgment_human', keys)

  const existing =
    rows.length === 0
      ? []
      : await tx.queryJson<{articleId: string; projectId: string; promptId: string}>(`
          SELECT project_id AS projectId, article_id AS articleId, prompt_id AS promptId
          FROM app.judgment_human
          WHERE ${rows
            .map((row) => {
              return `(project_id = ${getSqlLiteral(row.projectId)} AND article_id = ${getSqlLiteral(row.articleId)} AND prompt_id = ${getSqlLiteral(row.promptId)})`
            })
            .join(' OR ')}
          ORDER BY project_id ASC, article_id ASC, prompt_id ASC
        `)
  const conflict = existing[0]

  return conflict
    ? failCommitWriter(
        `target judgment_human already has remapped key ${conflict.projectId}:${conflict.articleId}:${conflict.promptId}`,
      )
    : undefined
}

const assertNoExistingHumanSummaries = async ({
  rows,
  tx,
}: {
  rows: readonly HumanJudgmentSummaryCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  const keys = rows.map((row) => {
    return `${row.projectId}\u0000${row.articleId}`
  })

  assertNoDuplicateRows('judgment_human_summary', keys)

  const existing =
    rows.length === 0
      ? []
      : await tx.queryJson<{articleId: string; projectId: string}>(`
          SELECT project_id AS projectId, article_id AS articleId
          FROM app.judgment_human_summary
          WHERE ${rows
            .map((row) => {
              return `(project_id = ${getSqlLiteral(row.projectId)} AND article_id = ${getSqlLiteral(row.articleId)})`
            })
            .join(' OR ')}
          ORDER BY project_id ASC, article_id ASC
        `)
  const conflict = existing[0]

  return conflict
    ? failCommitWriter(
        `target judgment_human_summary already has remapped key ${conflict.projectId}:${conflict.articleId}`,
      )
    : undefined
}

const assertNoExistingReviews = async ({
  rows,
  tx,
}: {
  rows: readonly ReviewCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  const keys = rows.map((row) => {
    return `${row.projectId}\u0000${row.articleId}`
  })

  assertNoDuplicateRows('review', keys)

  const existing =
    rows.length === 0
      ? []
      : await tx.queryJson<{articleId: string; projectId: string}>(`
          SELECT project_id AS projectId, article_id AS articleId
          FROM app.review
          WHERE ${rows
            .map((row) => {
              return `(project_id = ${getSqlLiteral(row.projectId)} AND article_id = ${getSqlLiteral(row.articleId)})`
            })
            .join(' OR ')}
          ORDER BY project_id ASC, article_id ASC
        `)
  const conflict = existing[0]

  return conflict
    ? failCommitWriter(`target review already has remapped key ${conflict.projectId}:${conflict.articleId}`)
    : undefined
}

const insertHumanJudgmentRows = async ({
  rows,
  tx,
}: {
  rows: readonly HumanJudgmentCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  await assertNoExistingHumanJudgments({rows, tx})

  return rows.length === 0
    ? undefined
    : runChunks(rows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.judgment_human (
          id,
          project_id,
          article_id,
          prompt_id,
          is_answered,
          answer,
          "comment",
          created_at,
          updated_at
        ) VALUES ${rowChunk
          .map((row) => {
            return `(
              ${getSqlLiteral(row.id)},
              ${getSqlLiteral(row.projectId)},
              ${getSqlLiteral(row.articleId)},
              ${getSqlLiteral(row.promptId)},
              ${getSqlLiteral(row.isAnswered)},
              ${getSqlLiteral(row.answer)},
              ${getSqlLiteral(row.comment)},
              ${getTimestampLiteral(row.createdAt)},
              ${getTimestampLiteral(row.updatedAt)}
            )`
          })
          .join(', ')}
      `)
      })
}

const insertHumanJudgmentSummaryRows = async ({
  rows,
  tx,
}: {
  rows: readonly HumanJudgmentSummaryCommitRow[]
  tx: ProjectTransferCommitWriterTx
}) => {
  await assertNoExistingHumanSummaries({rows, tx})

  return rows.length === 0
    ? undefined
    : runChunks(rows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.judgment_human_summary (
          id,
          project_id,
          article_id,
          answer,
          origin,
          created_at,
          updated_at
        ) VALUES ${rowChunk
          .map((row) => {
            return `(
              ${getSqlLiteral(row.id)},
              ${getSqlLiteral(row.projectId)},
              ${getSqlLiteral(row.articleId)},
              ${getSqlLiteral(row.answer)},
              ${getSqlLiteral(row.origin)},
              ${getTimestampLiteral(row.createdAt)},
              ${getTimestampLiteral(row.updatedAt)}
            )`
          })
          .join(', ')}
      `)
      })
}

const getReviewSection = (row: ReviewCommitRow, section: (typeof reviewSectionNames)[number]) => {
  return row.sections[section] ?? {comment: null, reviewed: false}
}

const insertReviewRows = async ({rows, tx}: {rows: readonly ReviewCommitRow[]; tx: ProjectTransferCommitWriterTx}) => {
  await assertNoExistingReviews({rows, tx})

  return rows.length === 0
    ? undefined
    : runChunks(rows, (rowChunk) => {
        return tx.run(`
        INSERT INTO app.review (
          id,
          project_id,
          article_id,
          opened,
          reviewed_title,
          reviewed_title_comment,
          reviewed_abstract,
          reviewed_abstract_comment,
          reviewed_intro,
          reviewed_intro_comment,
          reviewed_method,
          reviewed_method_comment,
          reviewed_results,
          reviewed_results_comment,
          reviewed_discussion,
          reviewed_discussion_comment,
          reviewed_conclusion,
          reviewed_conclusion_comment,
          reviewed_appendix,
          reviewed_appendix_comment,
          reviewed_other,
          reviewed_other_comment,
          created_at,
          updated_at
        ) VALUES ${rowChunk
          .map((row) => {
            const title = getReviewSection(row, 'title')
            const abstract = getReviewSection(row, 'abstract')
            const intro = getReviewSection(row, 'intro')
            const method = getReviewSection(row, 'method')
            const results = getReviewSection(row, 'results')
            const discussion = getReviewSection(row, 'discussion')
            const conclusion = getReviewSection(row, 'conclusion')
            const appendix = getReviewSection(row, 'appendix')
            const other = getReviewSection(row, 'other')

            return `(
              ${getSqlLiteral(row.id)},
              ${getSqlLiteral(row.projectId)},
              ${getSqlLiteral(row.articleId)},
              ${getSqlLiteral(row.opened)},
              ${getSqlLiteral(title.reviewed)},
              ${getSqlLiteral(title.comment)},
              ${getSqlLiteral(abstract.reviewed)},
              ${getSqlLiteral(abstract.comment)},
              ${getSqlLiteral(intro.reviewed)},
              ${getSqlLiteral(intro.comment)},
              ${getSqlLiteral(method.reviewed)},
              ${getSqlLiteral(method.comment)},
              ${getSqlLiteral(results.reviewed)},
              ${getSqlLiteral(results.comment)},
              ${getSqlLiteral(discussion.reviewed)},
              ${getSqlLiteral(discussion.comment)},
              ${getSqlLiteral(conclusion.reviewed)},
              ${getSqlLiteral(conclusion.comment)},
              ${getSqlLiteral(appendix.reviewed)},
              ${getSqlLiteral(appendix.comment)},
              ${getSqlLiteral(other.reviewed)},
              ${getSqlLiteral(other.comment)},
              ${getTimestampLiteral(row.createdAt)},
              ${getTimestampLiteral(row.updatedAt)}
            )`
          })
          .join(', ')}
      `)
      })
}

const writeProjectTransferCommitAppTablesTx = async ({
  commitId,
  now,
  payloads,
  plan,
  promotion,
  schemaVersion,
  sessionId,
  tx,
}: Omit<ProjectTransferCommitWriterInput, 'database'> & {tx: ProjectTransferCommitWriterTx}) => {
  const project = payloads.project ?? failCommitWriter('project payload is required')
  const prompts = payloads.prompts ?? []
  const projectPrompts = payloads.projectPrompts ?? []
  const articles = payloads.articles ?? []
  const projectArticles = payloads.projectArticles ?? []
  const articleImportRoutes = payloads.articleImportRoutes ?? []
  const judgments = payloads.judgments ?? []
  const judgmentAssessments = payloads.judgmentAssessments ?? []
  const humanJudgments = payloads.humanJudgments ?? []
  const humanJudgmentSummaries = payloads.humanJudgmentSummaries ?? []
  const reviews = payloads.reviews ?? []
  const importedAt = now ?? new Date()
  const judgmentPlan = getRequiredPlanEntries(plan.targetPlan.judgmentPlan, 'judgment plan', judgments.length)
  const judgmentAssessmentPlan = getRequiredPlanEntries(
    plan.targetPlan.judgmentAssessmentPlan,
    'judgment assessment plan',
    judgmentAssessments.length,
  )
  const humanReviewPlan = getRequiredPlanEntries(
    plan.targetPlan.humanReviewPlan,
    'human review plan',
    humanJudgments.length + humanJudgmentSummaries.length + reviews.length,
  )
  const createdProject = await insertImportedProject({
    models: payloads.models ?? [],
    now: importedAt,
    plan,
    project,
    tx,
  })
  const activeSourcePromptIds = getActiveSourcePromptIds(plan.targetPlan.projectPromptPlan)

  assertPromptPlanHashes({promptPlan: plan.targetPlan.promptPlan, prompts})

  const promptIdBySourceId = await getPromptIdBySourceId({activeSourcePromptIds, prompts, tx})
  const projectPromptRows = getProjectPromptRows({
    projectId: createdProject.id,
    projectPromptPlan: plan.targetPlan.projectPromptPlan,
    projectPrompts,
    promptIdBySourceId,
  })
  const articleIdBySourceId = getResolvedArticleIdBySourceId({
    articleMatches: plan.targetPlan.articleMatches,
    promotion,
  })

  await assertNoArticleIdConflicts({articles, matches: plan.targetPlan.articleMatches, tx})
  await insertProjectPromptRows(tx, projectPromptRows)
  await insertCreatedArticles({articleIdBySourceId, now: importedAt, promotion, tx})
  const targetArticleById = await getFillTargetArticleRows({promotion, tx})
  await updateReusedArticles({now: importedAt, promotion, targetArticleById, tx})
  await markUpdatedReusedArticlesDirty({promotion, tx})
  await insertArticleIdentifiers({articleIdBySourceId, articles, now: importedAt, tx})
  await insertProjectImportRoutes({
    projectId: createdProject.id,
    projectRoutePlan: plan.targetPlan.projectRoutePlan,
    tx,
  })
  const routeIdBySourceId = getRouteIdBySourceId(plan.targetPlan.projectRoutePlan)
  const articleImportRouteRows = getArticleImportRouteRows({
    articleIdBySourceId,
    articleImportRoutes,
    articleRoutePlan: plan.targetPlan.articleRoutePlan,
    routeIdBySourceId,
  })
  await insertArticleImportRoutes({rows: articleImportRouteRows, tx})
  await insertProjectArticles({
    articleIdBySourceId,
    articleRoutePlan: plan.targetPlan.articleRoutePlan,
    projectArticles,
    projectId: createdProject.id,
    tx,
  })
  await markImportedProjectDirty({projectId: createdProject.id, tx})
  const judgmentRows = getJudgmentRows({
    articleIdBySourceId,
    judgmentPlan,
    judgments,
    now: importedAt,
    plan,
    promptIdBySourceId,
  })
  await insertJudgmentRows({projectId: createdProject.id, rows: judgmentRows, tx})
  const judgmentIdBySourceId = getJudgmentIdBySourceId(judgmentRows)
  const judgmentAssessmentRows = getJudgmentAssessmentRows({
    assessmentPlan: judgmentAssessmentPlan,
    assessments: judgmentAssessments,
    judgmentIdBySourceId,
    now: importedAt,
  })
  await insertJudgmentAssessmentRows({
    allJudgmentIds: Object.values(judgmentIdBySourceId),
    rows: judgmentAssessmentRows,
    tx,
  })
  assertNoHumanReviewPlanExtras({humanJudgments, humanReviewPlan, humanSummaries: humanJudgmentSummaries, reviews})
  const humanJudgmentRows = getHumanJudgmentRows({
    articleIdBySourceId,
    humanJudgments,
    humanReviewPlan,
    now: importedAt,
    projectId: createdProject.id,
    promptIdBySourceId,
  })
  const humanSummaryRows = getHumanJudgmentSummaryRows({
    articleIdBySourceId,
    humanReviewPlan,
    humanSummaries: humanJudgmentSummaries,
    now: importedAt,
    projectId: createdProject.id,
  })
  const reviewRows = getReviewRows({
    articleIdBySourceId,
    humanReviewPlan,
    now: importedAt,
    projectId: createdProject.id,
    reviews,
  })
  await insertHumanJudgmentRows({rows: humanJudgmentRows, tx})
  await insertHumanJudgmentSummaryRows({rows: humanSummaryRows, tx})
  await insertReviewRows({rows: reviewRows, tx})
  const importWarnings = getCommitImportWarnings({
    articleRoutePlan: plan.targetPlan.articleRoutePlan,
    judgmentPlan,
    plan,
    projectRoutePlan: plan.targetPlan.projectRoutePlan,
  })
  const payloadCounts = getPayloadCounts(plan)
  const transferHistoryId = randomUUID()
  const completion = getCompletionPayload({
    finalCounts: getFinalCounts({
      articleIdBySourceId,
      humanJudgmentRows,
      humanSummaryRows,
      importWarnings,
      judgmentAssessmentRows,
      judgmentIdBySourceId,
      promptIdBySourceId,
      reviewRows,
      routeIdBySourceId,
    }),
    importWarnings,
    packageFingerprint: getRequiredString(plan.packageFingerprint, 'plan.packageFingerprint'),
    payloadCounts,
    projectId: createdProject.id,
    projectName: createdProject.name,
    transferHistoryId,
  })
  const history = await getProjectTransferHistoryRepository().createProjectTransferHistory({
    commitId,
    completionPayload: completion,
    direction: 'import',
    id: transferHistoryId,
    packageFingerprint: completion.packageFingerprint ?? failCommitWriter('completion package fingerprint is required'),
    payloadCounts,
    runner: tx,
    schemaVersion,
    sessionId,
    sourceProjectId: project.sourceProjectId,
    sourceProjectName: project.name,
    targetProjectId: createdProject.id,
    targetProjectName: createdProject.name,
  })

  return {
    articleIdBySourceId,
    completion,
    history,
    importWarnings,
    projectId: createdProject.id,
    projectName: createdProject.name,
    promptIdBySourceId,
    routeIdBySourceId,
  }
}

export const writeProjectTransferCommitAppTables = async ({
  database: inputDatabase,
  ...input
}: ProjectTransferCommitWriterInput): Promise<ProjectTransferCommitAppWriteResult> => {
  const database = inputDatabase ?? getAppDatabaseService()

  const result = await database.transaction((tx) => {
    return writeProjectTransferCommitAppTablesTx({...input, tx})
  })

  return result as ProjectTransferCommitAppWriteResult
}
