import {randomUUID} from 'node:crypto'

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
import type {ProjectTransferImportPlanArtifact} from './projectTransferAnalyze.ts'
import type {ProjectTransferTargetPlan} from './projectTransferAnalyzeTarget.ts'
import type {ProjectTransferCommitPromotionResult} from './projectTransferCommitRollback.ts'
import {getProjectTransferCanonicalJson} from './projectTransferFingerprint.ts'
import {getProjectTransferNormalizedArticleIdentifiers} from './projectTransferIdentifierNormalization.ts'
import type {
  ProjectTransferArticlePayloadRecord,
  ProjectTransferPayloadByKey,
  ProjectTransferPayloadRecord,
  ProjectTransferProjectPayload,
} from './projectTransferPayloadSchemas.ts'
import type {ProjectTransferPackageWarning} from './projectTransferSchemas.ts'

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
  sessionId: string
}

export type ProjectTransferCommitAppWriteResult = {
  articleIdBySourceId: Record<string, string>
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
type ProjectRoutePlanEntry = ProjectTransferTargetPlan['projectRoutePlan'][number]
type PromptPlanEntry = ProjectTransferTargetPlan['promptPlan'][number]
type ProjectPromptPlanEntry = ProjectTransferTargetPlan['projectPromptPlan'][number]

type TargetArticleFieldRow = Record<ArticleField, unknown> & {id: string}

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

const failCommitWriter = (message: string): never => {
  throw new Error(`Project transfer commit writer: ${message}`)
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

const getJsonLiteral = (value: unknown) => {
  return value === null || value === undefined ? 'NULL' : `CAST(${getSqlLiteral(JSON.stringify(value))} AS JSON)`
}

const getNullableDateLiteral = (value: unknown) => {
  const date = getDateValue(value)

  return date === null ? 'NULL' : getTimestampLiteral(date)
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
    : tx.run(`
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
        ) VALUES ${rows
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
      : await tx.queryJson<{articleId: string; id: string}>(`
          SELECT id, article_id AS articleId
          FROM app.article
          WHERE article_id IN (${getQuotedStringList(newLegacyIds).join(', ')})
          ORDER BY article_id ASC, id ASC
        `)
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
    : tx.run(`
        INSERT INTO app.article (
          id,
          ${Object.values(articleColumnByPayloadField).join(',\n')},
          created_at,
          updated_at
        ) VALUES ${promotion.articleCreates
          .map((entry) => {
            const articleId = articleIdBySourceId[entry.sourceArticleId]

            return articleId === undefined
              ? failCommitWriter(`missing target article id for ${entry.sourceArticleId}`)
              : getCreatedArticleValuesSql({article: entry.article, articleId, now})
          })
          .join(', ')}
      `)
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
      : await tx.queryJson<TargetArticleFieldRow>(`
          SELECT
            id,
            ${articleFieldSelectSql}
          FROM app.article
          WHERE id IN (${getQuotedStringList(targetArticleIds).join(', ')})
          ORDER BY id ASC
        `)

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
    : tx.run(`
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
        ) VALUES ${rows
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
    : tx.run(`
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
        ) VALUES ${rows
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
    : tx.run(`
        INSERT INTO app.project_import_route (id, project_id, import_route_id)
        VALUES ${rows
          .map((row) => {
            return `(${getSqlLiteral(randomUUID())}, ${getSqlLiteral(row.projectId)}, ${getSqlLiteral(row.importRouteId)})`
          })
          .join(', ')}
      `)
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
    : tx.run(`
        INSERT INTO app.project_article (id, project_id, article_id, imported_from_project_id)
        VALUES ${rows
          .map((row) => {
            return `(${getSqlLiteral(randomUUID())}, ${getSqlLiteral(row.projectId)}, ${getSqlLiteral(row.articleId)}, NULL)`
          })
          .join(', ')}
      `)
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

const writeProjectTransferCommitAppTablesTx = async ({
  now,
  payloads,
  plan,
  promotion,
  tx,
}: Omit<ProjectTransferCommitWriterInput, 'commitId' | 'database' | 'sessionId'> & {
  tx: ProjectTransferCommitWriterTx
}) => {
  const project = payloads.project ?? failCommitWriter('project payload is required')
  const prompts = payloads.prompts ?? []
  const projectPrompts = payloads.projectPrompts ?? []
  const articles = payloads.articles ?? []
  const projectArticles = payloads.projectArticles ?? []
  const articleImportRoutes = payloads.articleImportRoutes ?? []
  const importedAt = now ?? new Date()
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

  return {
    articleIdBySourceId,
    importWarnings: getOmittedRouteWarnings({
      articleRoutePlan: plan.targetPlan.articleRoutePlan,
      projectRoutePlan: plan.targetPlan.projectRoutePlan,
    }),
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
