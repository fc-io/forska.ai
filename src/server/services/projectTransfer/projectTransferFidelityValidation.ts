import type {ProviderConnectionForAdmin, ProviderModelRecord} from '../../providers/providerTypes.ts'
import {getSqlLiteral} from '../appQueryHelpers.ts'
import type {ProjectTransferAnalyzeTargetRunner, ProjectTransferTargetPlan} from './projectTransferAnalyzeTarget.ts'
import type {
  ProjectTransferConflictCounts,
  ProjectTransferOverlapCounts,
  ProjectTransferPlanBlocker,
} from './projectTransferContracts.ts'
import {
  getProjectTransferExportHumanReviewInputSignature,
  getProjectTransferExportJudgmentInputSignature,
} from './projectTransferExport.ts'
import {getProjectTransferCanonicalJson} from './projectTransferFingerprint.ts'
import type {
  ProjectTransferContentSettings,
  ProjectTransferPayloadByKey,
  ProjectTransferPayloadRecord,
} from './projectTransferPayloadSchemas.ts'

export type ProjectTransferJudgmentConflictStatus = 'blocked' | 'clear' | 'unknown'

export type ProjectTransferJudgmentPlanEntry = {
  action: 'blocked' | 'insert' | 'reuse' | 'unknown'
  conflictCodes: string[]
  inputSignatureMatches: boolean | null
  physicalKey: string | null
  provenanceKind: string | null
  reviewVisibleKey: string | null
  sourceJudgmentId: string
  targetArticleId: string | null
  targetJudgmentId: string | null
  targetModelId: string | null
  targetPromptId: string | null
}

export type ProjectTransferJudgmentAssessmentPlanEntry = {
  action: 'blocked' | 'insert' | 'reuse'
  conflictCodes: string[]
  sourceJudgmentAssessmentId: string
  sourceJudgmentId: string
  targetAssessmentId: string | null
  targetJudgmentId: string | null
}

export type ProjectTransferHumanReviewPlanEntry = {
  action: 'blocked' | 'insert'
  conflictCodes: string[]
  inputSignatureMatches: boolean | null
  kind: 'humanJudgment' | 'humanJudgmentSummary' | 'review'
  provenanceKind: string | null
  sourceId: string
  targetArticleId: string | null
  targetPromptId: string | null
  uniqueKey: string | null
}

export type ProjectTransferFidelityTargetPlan = {
  humanReviewPlan: ProjectTransferHumanReviewPlanEntry[]
  judgmentAssessmentPlan: ProjectTransferJudgmentAssessmentPlanEntry[]
  judgmentPlan: ProjectTransferJudgmentPlanEntry[]
}

export type ProjectTransferFidelityValidationInput = {
  dependencyResolution?: {
    modelTargetBySourceId: Record<string, string>
    providerTargetBySourceId: Record<string, string>
  } | null
  payloads: Partial<ProjectTransferPayloadByKey>
  runner?: ProjectTransferAnalyzeTargetRunner | null
  targetConnections?: ProviderConnectionForAdmin[]
  targetPlan: ProjectTransferTargetPlan
}

type ProjectTransferFidelityValidationResult = {
  blockers: ProjectTransferPlanBlocker[]
  conflictCounts: Pick<ProjectTransferConflictCounts, 'humanReviewFidelityConflictCount' | 'judgmentConflictCount'>
  judgmentConflictStatus: ProjectTransferJudgmentConflictStatus
  overlapCounts: Pick<
    ProjectTransferOverlapCounts,
    | 'currentReviewRowsSignatureHumanReviewCount'
    | 'currentReviewRowsSignatureJudgmentCount'
    | 'reusedJudgmentCount'
    | 'snapshotVerifiedJudgmentCount'
    | 'storedSignatureHumanReviewCount'
    | 'storedSignatureJudgmentCount'
  >
  targetPlan: ProjectTransferFidelityTargetPlan
}

type JudgmentSignatureInput = Parameters<typeof getProjectTransferExportJudgmentInputSignature>[0]
type HumanReviewSignatureInput = Parameters<typeof getProjectTransferExportHumanReviewInputSignature>[0]
type ExportArticleInput = JudgmentSignatureInput['article']
type ExportModelInput = JudgmentSignatureInput['model']
type ExportPromptInput = JudgmentSignatureInput['prompt']
type ExportProviderConnectionInput = JudgmentSignatureInput['providerConnection']

type TargetJudgmentRow = {
  answeredOriginal: string | null
  answeredOriginalAsArray: unknown
  confidenceOriginal: number | null
  deleteGeneration: number | null
  explanation: string | null
  isAnswered: boolean | null
  quotes: unknown
  targetArticleId: string
  targetJudgmentId: string
  targetModelId: string
  targetPromptId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

type TargetJudgmentAssessmentRow = {
  assessmentComment: string | null
  assessmentIsCorrect: boolean | null
  targetAssessmentId: string
  targetJudgmentId: string
}

const fidelityBlockerCodePrefixes = [
  'human_review_',
  'human_summary_',
  'human_judgment_',
  'judgment_',
  'review_',
] as const

export const isProjectTransferFidelityBlocker = (blocker: ProjectTransferPlanBlocker) => {
  return fidelityBlockerCodePrefixes.some((prefix) => {
    return blocker.code.startsWith(prefix)
  })
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

const getNullableStringField = (record: Record<string, unknown>, field: string) => {
  const value = getRecordField(record, field)

  return typeof value === 'string' && value.trim() !== '' ? value : null
}

const getBooleanField = (record: Record<string, unknown>, field: string) => {
  return getRecordField(record, field) === true
}

const getNumberField = (record: Record<string, unknown>, field: string, fallback: number | null = null) => {
  const value = getRecordField(record, field)

  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

const getCanonicalValue = (value: unknown) => {
  return getProjectTransferCanonicalJson(value ?? null)
}

const valuesEquivalent = (left: unknown, right: unknown) => {
  return getCanonicalValue(left) === getCanonicalValue(right)
}

const getJudgmentFidelitySignature = (signature: unknown) => {
  return isRecord(signature)
    ? {
        article: signature.article,
        chunking: signature.chunking,
        contentSettings: getComparableContentSettings(signature.contentSettings),
        fullTextProcessing: signature.fullTextProcessing,
        model: getComparableJudgmentModel(signature.model),
        prompt: signature.prompt,
        provider: getComparableJudgmentProvider(signature.provider),
      }
    : null
}

const judgmentSignaturesEquivalent = (left: unknown, right: unknown) => {
  return valuesEquivalent(getJudgmentFidelitySignature(left), getJudgmentFidelitySignature(right))
}

const getComparableContentSettings = (value: unknown): ProjectTransferContentSettings => {
  const settings = isRecord(value) ? value : {}

  return {
    useAbstract: settings.useAbstract !== false,
    useFulltext: settings.useFulltext === true,
    useFulltextNoImages: settings.useFulltextNoImages === true,
    useTitle: settings.useTitle !== false,
  }
}

const getComparableJudgmentModel = (value: unknown) => {
  const model = isRecord(value) ? value : {}
  const modelSignature = isRecord(model.modelSignature) ? model.modelSignature : {}

  return {
    contextLimit: model.contextLimit,
    modelOptions: model.modelOptions,
    modelSignature: {
      displayName: modelSignature.displayName,
      modelName: modelSignature.modelName,
      name: modelSignature.name,
      remoteModelId: modelSignature.remoteModelId,
      variant: modelSignature.variant,
      version: modelSignature.version,
    },
    promptTokenLimit: model.promptTokenLimit,
  }
}

const getComparableJudgmentProvider = (value: unknown) => {
  const provider = isRecord(value) ? value : {}

  return {providerKind: provider.providerKind, transportFamily: provider.transportFamily}
}

const getSqlValueList = (values: readonly string[]) => {
  return values.map(getSqlLiteral).join(', ')
}

const getNonNewTargetIds = (values: readonly (string | null)[]) => {
  return [
    ...new Set(
      values.filter((value): value is string => {
        return value !== null && !value.startsWith('new:')
      }),
    ),
  ]
}

const getProjectTargetId = (payloads: Partial<ProjectTransferPayloadByKey>) => {
  const sourceProjectId = payloads.project?.sourceProjectId

  return typeof sourceProjectId === 'string' && sourceProjectId.trim() !== '' ? `new:project:${sourceProjectId}` : null
}

const getArticleTargetIdBySource = (targetPlan: ProjectTransferTargetPlan) => {
  return targetPlan.articleMatches.reduce<Record<string, string | null>>((mapped, match) => {
    const createdTargetId = match.action === 'create' ? `new:article:${match.sourceArticleId}` : null
    const targetArticleId = match.selectedTargetArticleId ?? createdTargetId

    return {...mapped, [match.sourceArticleId]: targetArticleId}
  }, {})
}

const getPromptTargetIdBySource = (targetPlan: ProjectTransferTargetPlan) => {
  return targetPlan.promptPlan.reduce<Record<string, string | null>>((mapped, prompt) => {
    const createdTargetId = prompt.action === 'create' ? `new:prompt:${prompt.computedContentHash}` : null
    const targetPromptId = prompt.targetPromptId ?? createdTargetId

    return {...mapped, [prompt.sourcePromptId]: targetPromptId}
  }, {})
}

const getProjectPromptPlanBySourcePrompt = (targetPlan: ProjectTransferTargetPlan) => {
  return targetPlan.projectPromptPlan.reduce<Record<string, ProjectTransferTargetPlan['projectPromptPlan'][number]>>(
    (mapped, prompt) => {
      return mapped[prompt.sourcePromptId] ? mapped : {...mapped, [prompt.sourcePromptId]: prompt}
    },
    {},
  )
}

const getPromptPlanBySource = (targetPlan: ProjectTransferTargetPlan) => {
  return targetPlan.promptPlan.reduce<Record<string, ProjectTransferTargetPlan['promptPlan'][number]>>(
    (mapped, prompt) => {
      return {...mapped, [prompt.sourcePromptId]: prompt}
    },
    {},
  )
}

const getRowsBySourceId = (rows: readonly ProjectTransferPayloadRecord[], field: string) => {
  return rows.reduce<Record<string, ProjectTransferPayloadRecord>>((mapped, row) => {
    const sourceId = getStringField(row, field)

    return sourceId ? {...mapped, [sourceId]: row} : mapped
  }, {})
}

const getArticleInputBySource = ({
  payloads,
  targetPlan,
}: {
  payloads: Partial<ProjectTransferPayloadByKey>
  targetPlan: ProjectTransferTargetPlan
}) => {
  const sourceArticlesById = getRowsBySourceId(payloads.articles ?? [], 'sourceArticleId')
  const updatesBySource = targetPlan.articleUpdatePlan.reduce<
    Record<string, ProjectTransferTargetPlan['articleUpdatePlan'][number]>
  >((mapped, update) => {
    return {...mapped, [update.sourceArticleId]: update}
  }, {})

  return targetPlan.articleMatches.reduce<Record<string, ExportArticleInput>>((mapped, match) => {
    const sourceArticle = sourceArticlesById[match.sourceArticleId]
    const targetArticle = match.candidates.find((candidate) => {
      return candidate.targetArticleId === match.selectedTargetArticleId
    })?.targetArticle
    const baseArticle = targetArticle ?? sourceArticle ?? null
    const update = updatesBySource[match.sourceArticleId] ?? null
    const filledArticle = update
      ? update.fieldFills.reduce<Record<string, unknown>>(
          (article, fill) => {
            return {...article, [fill.field]: fill.value}
          },
          {...(baseArticle ?? {})},
        )
      : baseArticle

    return filledArticle ? {...mapped, [match.sourceArticleId]: filledArticle as ExportArticleInput} : mapped
  }, {})
}

const getPromptInputBySource = ({
  payloads,
  targetPlan,
}: {
  payloads: Partial<ProjectTransferPayloadByKey>
  targetPlan: ProjectTransferTargetPlan
}) => {
  const promptsBySource = getRowsBySourceId(payloads.prompts ?? [], 'sourcePromptId')
  const projectPromptBySource = getProjectPromptPlanBySourcePrompt(targetPlan)
  const promptPlanBySource = getPromptPlanBySource(targetPlan)

  return (payloads.prompts ?? []).reduce<Record<string, ExportPromptInput>>((mapped, prompt) => {
    const sourcePromptId = getStringField(prompt, 'sourcePromptId')
    const projectPrompt = projectPromptBySource[sourcePromptId] ?? null
    const promptPlan = promptPlanBySource[sourcePromptId] ?? null
    const sourcePrompt = promptsBySource[sourcePromptId] ?? prompt

    return {
      ...mapped,
      [sourcePromptId]: {
        contentHash: promptPlan?.computedContentHash ?? getNullableStringField(sourcePrompt, 'contentHash'),
        order: projectPrompt?.order ?? null,
        originalText: getStringField(sourcePrompt, 'originalText'),
        promptHeading: getNullableStringField(sourcePrompt, 'promptHeading'),
        transformedText: getNullableStringField(sourcePrompt, 'transformedText'),
        type: getNullableStringField(sourcePrompt, 'type'),
      } as ExportPromptInput,
    }
  }, {})
}

const getSourceProviderInputById = (payloads: Partial<ProjectTransferPayloadByKey>) => {
  return (payloads.providerConnections ?? []).reduce<Record<string, ExportProviderConnectionInput>>((mapped, row) => {
    const sourceProviderConnectionId = getStringField(row, 'sourceProviderConnectionId')

    return {
      ...mapped,
      [sourceProviderConnectionId]: {
        authMode: getNullableStringField(row, 'authMode'),
        baseURL: getNullableStringField(row, 'baseURL'),
        configJson: getRecordField(row, 'configJson'),
        providerConnectionId: sourceProviderConnectionId,
        providerKind: getStringField(row, 'providerKind'),
      } as ExportProviderConnectionInput,
    }
  }, {})
}

const getSourceModelInputById = (payloads: Partial<ProjectTransferPayloadByKey>) => {
  return (payloads.models ?? []).reduce<Record<string, ExportModelInput>>((mapped, row) => {
    const sourceModelId = getStringField(row, 'sourceModelId')

    return {
      ...mapped,
      [sourceModelId]: {
        displayName: getNullableStringField(row, 'displayName'),
        metadataJson: getRecordField(row, 'metadataJson'),
        modelId: sourceModelId,
        modelName: getStringField(row, 'modelName'),
        name: getStringField(row, 'name'),
        providerConnectionId: getStringField(row, 'sourceProviderConnectionId'),
        remoteModelId: getNullableStringField(row, 'remoteModelId'),
        source: getNullableStringField(row, 'source'),
        variant: getNullableStringField(row, 'variant'),
        version: getNullableStringField(row, 'version'),
      } as ExportModelInput,
    }
  }, {})
}

const getTargetProviderInputById = (targetConnections: readonly ProviderConnectionForAdmin[] = []) => {
  return targetConnections.reduce<Record<string, ExportProviderConnectionInput>>((mapped, connection) => {
    return {
      ...mapped,
      [connection.id]: {
        authMode: connection.authMode,
        baseURL: connection.baseURL,
        configJson: connection.config,
        providerConnectionId: connection.id,
        providerKind: connection.providerKind,
      } as ExportProviderConnectionInput,
    }
  }, {})
}

const getTargetModelInputById = (targetConnections: readonly ProviderConnectionForAdmin[] = []) => {
  return targetConnections
    .flatMap((connection) => {
      return connection.models
    })
    .reduce<Record<string, ExportModelInput>>((mapped, model: ProviderModelRecord) => {
      return {
        ...mapped,
        [model.id]: {
          displayName: model.displayName,
          metadataJson: model.metadataJson,
          modelId: model.id,
          modelName: model.modelName,
          name: model.name,
          providerConnectionId: model.providerConnectionId,
          remoteModelId: model.remoteModelId,
          source: model.source,
          variant: model.variant,
          version: model.version,
        } as ExportModelInput,
      }
    }, {})
}

const getModelTargetIdBySource = ({
  dependencyResolution,
  payloads,
}: {
  dependencyResolution?: ProjectTransferFidelityValidationInput['dependencyResolution']
  payloads: Partial<ProjectTransferPayloadByKey>
}) => {
  const sourceModelInputById = getSourceModelInputById(payloads)

  return (payloads.models ?? []).reduce<Record<string, string | null>>((mapped, model) => {
    const sourceModelId = getStringField(model, 'sourceModelId')
    const targetModelId = dependencyResolution?.modelTargetBySourceId[sourceModelId] ?? null

    return {...mapped, [sourceModelId]: targetModelId ?? (sourceModelInputById[sourceModelId] ? sourceModelId : null)}
  }, {})
}

const getContentSettings = (judgment: ProjectTransferPayloadRecord): ProjectTransferContentSettings => {
  const settings = isRecord(judgment.contentSettings) ? judgment.contentSettings : {}

  return {
    useAbstract: settings.useAbstract !== false,
    useFulltext: settings.useFulltext === true,
    useFulltextNoImages: settings.useFulltextNoImages === true,
    useTitle: settings.useTitle !== false,
  }
}

const getProvenanceKind = (record: ProjectTransferPayloadRecord, field: string) => {
  const provenance = getRecordField(record, field)

  return isRecord(provenance) ? getNullableStringField(provenance, 'kind') : null
}

const getInitialProvenanceCounts = (): ProjectTransferFidelityValidationResult['overlapCounts'] => {
  return {
    currentReviewRowsSignatureHumanReviewCount: 0,
    currentReviewRowsSignatureJudgmentCount: 0,
    reusedJudgmentCount: 0,
    snapshotVerifiedJudgmentCount: 0,
    storedSignatureHumanReviewCount: 0,
    storedSignatureJudgmentCount: 0,
  }
}

const incrementProvenanceCount = ({
  counts,
  kind,
  prefix,
}: {
  counts: ProjectTransferFidelityValidationResult['overlapCounts']
  kind: string | null
  prefix: 'humanReview' | 'judgment'
}) => {
  const currentKey =
    prefix === 'judgment' ? 'currentReviewRowsSignatureJudgmentCount' : 'currentReviewRowsSignatureHumanReviewCount'
  const storedKey = prefix === 'judgment' ? 'storedSignatureJudgmentCount' : 'storedSignatureHumanReviewCount'
  const snapshotKey = prefix === 'judgment' ? 'snapshotVerifiedJudgmentCount' : null

  return kind === 'currentReviewRows'
    ? {...counts, [currentKey]: counts[currentKey] + 1}
    : kind === 'stored' || kind === 'storedSignature'
      ? {...counts, [storedKey]: counts[storedKey] + 1}
      : snapshotKey !== null && (kind === 'snapshotVerified' || kind === 'snapshot-verified')
        ? {...counts, [snapshotKey]: counts[snapshotKey] + 1}
        : counts
}

const getSignatureProvenanceCounts = (payloads: Partial<ProjectTransferPayloadByKey>) => {
  const judgmentCounts = (payloads.judgments ?? []).reduce((counts, judgment) => {
    return incrementProvenanceCount({
      counts,
      kind: getProvenanceKind(judgment, 'judgmentInputSignatureProvenance'),
      prefix: 'judgment',
    })
  }, getInitialProvenanceCounts())

  return [
    ...(payloads.humanJudgments ?? []),
    ...(payloads.humanJudgmentSummaries ?? []),
    ...(payloads.reviews ?? []),
  ].reduce((counts, row) => {
    return incrementProvenanceCount({
      counts,
      kind: getProvenanceKind(row, 'humanReviewInputSignatureProvenance'),
      prefix: 'humanReview',
    })
  }, judgmentCounts)
}

const getJudgmentPhysicalKey = ({
  judgment,
  targetArticleId,
  targetModelId,
  targetPromptId,
}: {
  judgment: ProjectTransferPayloadRecord
  targetArticleId: string | null
  targetModelId: string | null
  targetPromptId: string | null
}) => {
  const settings = getContentSettings(judgment)

  return targetArticleId === null || targetPromptId === null || targetModelId === null
    ? null
    : [
        targetArticleId,
        targetPromptId,
        targetModelId,
        String(settings.useTitle),
        String(settings.useAbstract),
        String(settings.useFulltext),
        String(settings.useFulltextNoImages),
        String(getNumberField(judgment, 'deleteGeneration', 0) ?? 0),
      ].join(':')
}

const getJudgmentReviewVisibleKey = ({
  judgment,
  targetArticleId,
  targetModelId,
  targetPromptId,
}: {
  judgment: ProjectTransferPayloadRecord
  targetArticleId: string | null
  targetModelId: string | null
  targetPromptId: string | null
}) => {
  const settings = getContentSettings(judgment)

  return targetArticleId === null || targetPromptId === null || targetModelId === null
    ? null
    : [
        targetArticleId,
        targetPromptId,
        targetModelId,
        String(settings.useTitle),
        String(settings.useAbstract),
        String(settings.useFulltext),
        String(settings.useFulltextNoImages),
      ].join(':')
}

const getTargetJudgmentPhysicalKey = (row: TargetJudgmentRow) => {
  return [
    row.targetArticleId,
    row.targetPromptId,
    row.targetModelId,
    String(row.useTitle),
    String(row.useAbstract),
    String(row.useFulltext),
    String(row.useFulltextNoImages),
    String(row.deleteGeneration ?? 0),
  ].join(':')
}

const getTargetJudgmentReviewVisibleKey = (row: TargetJudgmentRow) => {
  return [
    row.targetArticleId,
    row.targetPromptId,
    row.targetModelId,
    String(row.useTitle),
    String(row.useAbstract),
    String(row.useFulltext),
    String(row.useFulltextNoImages),
  ].join(':')
}

const getTargetJudgmentRows = async ({
  keys,
  runner,
}: {
  keys: readonly {targetArticleId: string | null; targetModelId: string | null; targetPromptId: string | null}[]
  runner?: ProjectTransferAnalyzeTargetRunner | null
}) => {
  const targetArticleIds = getNonNewTargetIds(
    keys.map((key) => {
      return key.targetArticleId
    }),
  )
  const targetPromptIds = getNonNewTargetIds(
    keys.map((key) => {
      return key.targetPromptId
    }),
  )
  const targetModelIds = getNonNewTargetIds(
    keys.map((key) => {
      return key.targetModelId
    }),
  )

  return runner === null
    || runner === undefined
    || targetArticleIds.length === 0
    || targetPromptIds.length === 0
    || targetModelIds.length === 0
    ? []
    : runner.queryJson<TargetJudgmentRow>(`
      SELECT
        id AS targetJudgmentId,
        article_id AS targetArticleId,
        prompt_id AS targetPromptId,
        model_id AS targetModelId,
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
        AND article_id IN (${getSqlValueList(targetArticleIds)})
        AND prompt_id IN (${getSqlValueList(targetPromptIds)})
        AND model_id IN (${getSqlValueList(targetModelIds)})
      ORDER BY article_id ASC, prompt_id ASC, model_id ASC, id ASC
    `)
}

const getTargetJudgmentAssessmentRows = async ({
  runner,
  targetJudgmentIds,
}: {
  runner?: ProjectTransferAnalyzeTargetRunner | null
  targetJudgmentIds: readonly string[]
}) => {
  const concreteIds = getNonNewTargetIds(targetJudgmentIds)

  return runner === null || runner === undefined || concreteIds.length === 0
    ? []
    : runner.queryJson<TargetJudgmentAssessmentRow>(`
      SELECT
        id AS targetAssessmentId,
        judgment_id AS targetJudgmentId,
        assessment_is_correct AS assessmentIsCorrect,
        assessment_comment AS assessmentComment
      FROM app.judgment_assessment
      WHERE judgment_id IN (${getSqlValueList(concreteIds)})
      ORDER BY judgment_id ASC, id ASC
    `)
}

const getDuplicateKeyBlockers = ({
  code,
  entries,
  getKey,
  getScope,
  message,
}: {
  code: string
  entries: readonly ProjectTransferPayloadRecord[]
  getKey: (entry: ProjectTransferPayloadRecord) => string | null
  getScope: (entry: ProjectTransferPayloadRecord) => string
  message: string
}) => {
  const groups = entries.reduce<Map<string, ProjectTransferPayloadRecord[]>>((mapped, entry) => {
    const key = getKey(entry)
    const existing = key === null ? [] : (mapped.get(key) ?? [])

    return key === null ? mapped : mapped.set(key, [...existing, entry])
  }, new Map())

  return [...groups.values()]
    .filter((group) => {
      return group.length > 1
    })
    .flatMap((group) => {
      return group.map((entry) => {
        return getPlanBlocker({code, message, scope: getScope(entry)})
      })
    })
}

const getJudgmentSignature = ({
  articleInputBySource,
  judgment,
  modelInputById,
  promptInputBySource,
  providerInputById,
}: {
  articleInputBySource: Record<string, ExportArticleInput>
  judgment: ProjectTransferPayloadRecord
  modelInputById: Record<string, ExportModelInput>
  promptInputBySource: Record<string, ExportPromptInput>
  providerInputById: Record<string, ExportProviderConnectionInput>
}) => {
  const sourceArticleId = getStringField(judgment, 'sourceArticleId')
  const sourceModelId = getStringField(judgment, 'sourceModelId')
  const sourcePromptId = getStringField(judgment, 'sourcePromptId')
  const article = articleInputBySource[sourceArticleId] ?? null
  const prompt = promptInputBySource[sourcePromptId] ?? null
  const model = modelInputById[sourceModelId] ?? null
  const providerConnection = model ? (providerInputById[model.providerConnectionId] ?? null) : null

  return article && prompt && model && providerConnection
    ? getProjectTransferExportJudgmentInputSignature({
        article,
        chunkingStrategy: getNullableStringField(judgment, 'chunkingStrategy'),
        contentSettings: getContentSettings(judgment),
        model,
        prompt,
        providerConnection,
      })
    : null
}

const getReviewSectionSignature = (review: ProjectTransferPayloadRecord) => {
  const sections = isRecord(review.sections) ? review.sections : {}

  return Object.fromEntries(
    Object.entries(sections).map(([section, value]) => {
      return [section, isRecord(value) ? value.reviewed === true : false]
    }),
  )
}

const getHumanReviewSignature = ({
  articleInputBySource,
  promptInputBySource,
  record,
  type,
}: {
  articleInputBySource: Record<string, ExportArticleInput>
  promptInputBySource: Record<string, ExportPromptInput>
  record: ProjectTransferPayloadRecord
  type: ProjectTransferHumanReviewPlanEntry['kind']
}) => {
  const sourceArticleId = getStringField(record, 'sourceArticleId')
  const sourcePromptId = getStringField(record, 'sourcePromptId')
  const article = articleInputBySource[sourceArticleId] ?? null
  const prompt = promptInputBySource[sourcePromptId] ?? null
  const mode =
    type === 'humanJudgment'
      ? 'promptHumanJudgment'
      : type === 'humanJudgmentSummary'
        ? 'summaryHumanJudgment'
        : 'reviewRow'
  const input =
    type === 'humanJudgment'
      ? article && prompt
        ? {article, mode, prompt}
        : null
      : type === 'review'
        ? article
          ? {article, mode, sections: getReviewSectionSignature(record)}
          : null
        : article
          ? {article, mode}
          : null

  return input === null ? null : getProjectTransferExportHumanReviewInputSignature(input as HumanReviewSignatureInput)
}

const getTargetJudgmentFieldSignature = (row: TargetJudgmentRow) => {
  return {
    answeredOriginal: row.answeredOriginal,
    answeredOriginalAsArray: Array.isArray(row.answeredOriginalAsArray) ? row.answeredOriginalAsArray : [],
    confidenceOriginal: row.confidenceOriginal ?? 50,
    explanation: row.explanation,
    isAnswered: row.isAnswered ?? false,
    quotes: Array.isArray(row.quotes) ? row.quotes : [],
  }
}

const getImportedJudgmentFieldSignature = (judgment: ProjectTransferPayloadRecord) => {
  return {
    answeredOriginal: getNullableStringField(judgment, 'answeredOriginal'),
    answeredOriginalAsArray: Array.isArray(judgment.answeredOriginalAsArray) ? judgment.answeredOriginalAsArray : [],
    confidenceOriginal: getNumberField(judgment, 'confidenceOriginal', 50),
    explanation: getNullableStringField(judgment, 'explanation'),
    isAnswered: getBooleanField(judgment, 'isAnswered'),
    quotes: Array.isArray(judgment.quotes) ? judgment.quotes : [],
  }
}

const getImportedAssessmentSignature = (assessment: ProjectTransferPayloadRecord) => {
  return {
    assessmentComment: getNullableStringField(assessment, 'assessmentComment'),
    assessmentIsCorrect: getBooleanField(assessment, 'assessmentIsCorrect'),
  }
}

const getTargetAssessmentSignature = (assessment: TargetJudgmentAssessmentRow) => {
  return {assessmentComment: assessment.assessmentComment, assessmentIsCorrect: assessment.assessmentIsCorrect ?? false}
}

const getBlockersForJudgmentPlanEntry = ({
  entry,
  sourceJudgmentId,
}: {
  entry: ProjectTransferJudgmentPlanEntry
  sourceJudgmentId: string
}) => {
  return entry.conflictCodes.map((code) => {
    return getPlanBlocker({
      code,
      message: `${sourceJudgmentId} cannot preserve its imported judgment against the final target input`,
      scope: `judgments.${sourceJudgmentId}`,
    })
  })
}

const getBlockersForHumanReviewPlanEntry = (entry: ProjectTransferHumanReviewPlanEntry) => {
  return entry.conflictCodes.map((code) => {
    return getPlanBlocker({
      code,
      message: `${entry.sourceId} cannot preserve its imported human/review state against the final target input`,
      scope: `${entry.kind}.${entry.sourceId}`,
    })
  })
}

const getJudgmentModelRows = ({
  dependencyResolution,
  payloads,
  targetConnections,
}: {
  dependencyResolution?: ProjectTransferFidelityValidationInput['dependencyResolution']
  payloads: Partial<ProjectTransferPayloadByKey>
  targetConnections?: ProviderConnectionForAdmin[]
}) => {
  const sourceModelInputById = getSourceModelInputById(payloads)
  const sourceProviderInputById = getSourceProviderInputById(payloads)
  const targetModelInputById = getTargetModelInputById(targetConnections)
  const targetProviderInputById = getTargetProviderInputById(targetConnections)
  const modelInputById = Object.entries(getModelTargetIdBySource({dependencyResolution, payloads})).reduce<
    Record<string, ExportModelInput>
  >((mapped, [sourceModelId, targetModelId]) => {
    const targetModel = targetModelId ? (targetModelInputById[targetModelId] ?? null) : null
    const sourceModel = sourceModelInputById[sourceModelId] ?? null

    return (targetModel ?? sourceModel)
      ? {...mapped, [sourceModelId]: (targetModel ?? sourceModel) as ExportModelInput}
      : mapped
  }, {})
  const providerInputById = Object.values(modelInputById).reduce<Record<string, ExportProviderConnectionInput>>(
    (mapped, model) => {
      const targetProvider = targetProviderInputById[model.providerConnectionId] ?? null
      const sourceProvider = sourceProviderInputById[model.providerConnectionId] ?? null

      return (targetProvider ?? sourceProvider)
        ? {...mapped, [model.providerConnectionId]: (targetProvider ?? sourceProvider) as ExportProviderConnectionInput}
        : mapped
    },
    {},
  )

  return {modelInputById, providerInputById}
}

const getJudgmentPlan = async ({
  articleTargetIdBySource,
  input,
  modelTargetIdBySource,
  promptTargetIdBySource,
}: {
  articleTargetIdBySource: Record<string, string | null>
  input: ProjectTransferFidelityValidationInput
  modelTargetIdBySource: Record<string, string | null>
  promptTargetIdBySource: Record<string, string | null>
}) => {
  const articleInputBySource = getArticleInputBySource({payloads: input.payloads, targetPlan: input.targetPlan})
  const promptInputBySource = getPromptInputBySource({payloads: input.payloads, targetPlan: input.targetPlan})
  const {modelInputById, providerInputById} = getJudgmentModelRows({
    dependencyResolution: input.dependencyResolution,
    payloads: input.payloads,
    targetConnections: input.targetConnections,
  })
  const judgmentKeys = (input.payloads.judgments ?? []).map((judgment) => {
    const targetArticleId = articleTargetIdBySource[getStringField(judgment, 'sourceArticleId')] ?? null
    const targetPromptId = promptTargetIdBySource[getStringField(judgment, 'sourcePromptId')] ?? null
    const targetModelId = modelTargetIdBySource[getStringField(judgment, 'sourceModelId')] ?? null

    return {targetArticleId, targetModelId, targetPromptId}
  })
  const targetJudgments = await getTargetJudgmentRows({keys: judgmentKeys, runner: input.runner})
  const targetJudgmentByPhysicalKey = targetJudgments.reduce<Record<string, TargetJudgmentRow>>((mapped, row) => {
    return {...mapped, [getTargetJudgmentPhysicalKey(row)]: row}
  }, {})
  const targetJudgmentsByVisibleKey = targetJudgments.reduce<Record<string, TargetJudgmentRow[]>>((mapped, row) => {
    const key = getTargetJudgmentReviewVisibleKey(row)
    const existing = mapped[key] ?? []

    return {...mapped, [key]: [...existing, row]}
  }, {})
  const duplicatePhysicalKeyBlockers = getDuplicateKeyBlockers({
    code: 'judgment_package_duplicate_physical_key',
    entries: input.payloads.judgments ?? [],
    getKey: (judgment) => {
      return getJudgmentPhysicalKey({
        judgment,
        targetArticleId: articleTargetIdBySource[getStringField(judgment, 'sourceArticleId')] ?? null,
        targetModelId: modelTargetIdBySource[getStringField(judgment, 'sourceModelId')] ?? null,
        targetPromptId: promptTargetIdBySource[getStringField(judgment, 'sourcePromptId')] ?? null,
      })
    },
    getScope: (judgment) => {
      return `judgments.${getStringField(judgment, 'sourceJudgmentId')}`
    },
    message: 'Imported judgments contain duplicate final physical keys',
  })
  const duplicatePhysicalKeyBlockerScopes = new Set(
    duplicatePhysicalKeyBlockers.map((blocker) => {
      return blocker.scope
    }),
  )
  const plan = (input.payloads.judgments ?? []).map((judgment): ProjectTransferJudgmentPlanEntry => {
    const sourceJudgmentId = getStringField(judgment, 'sourceJudgmentId')
    const sourceArticleId = getStringField(judgment, 'sourceArticleId')
    const sourceModelId = getStringField(judgment, 'sourceModelId')
    const sourcePromptId = getStringField(judgment, 'sourcePromptId')
    const targetArticleId = articleTargetIdBySource[sourceArticleId] ?? null
    const targetPromptId = promptTargetIdBySource[sourcePromptId] ?? null
    const targetModelId = modelTargetIdBySource[sourceModelId] ?? null
    const physicalKey = getJudgmentPhysicalKey({judgment, targetArticleId, targetModelId, targetPromptId})
    const reviewVisibleKey = getJudgmentReviewVisibleKey({judgment, targetArticleId, targetModelId, targetPromptId})
    const targetJudgment = physicalKey ? (targetJudgmentByPhysicalKey[physicalKey] ?? null) : null
    const visibleConflicts =
      reviewVisibleKey === null
        ? []
        : (targetJudgmentsByVisibleKey[reviewVisibleKey] ?? []).filter((row) => {
            return getTargetJudgmentPhysicalKey(row) !== physicalKey
          })
    const computedSignature = getJudgmentSignature({
      articleInputBySource,
      judgment,
      modelInputById,
      promptInputBySource,
      providerInputById,
    })
    const inputSignatureMatches =
      computedSignature === null
        ? null
        : judgmentSignaturesEquivalent(computedSignature, judgment.judgmentInputSignature)
    const fieldSignatureMatches =
      targetJudgment === null
        ? true
        : valuesEquivalent(getTargetJudgmentFieldSignature(targetJudgment), getImportedJudgmentFieldSignature(judgment))
    const conflictCodes = [
      ...(targetArticleId === null || targetPromptId === null || targetModelId === null
        ? ['judgment_unique_key_unresolved']
        : []),
      ...(duplicatePhysicalKeyBlockerScopes.has(`judgments.${sourceJudgmentId}`)
        ? ['judgment_package_duplicate_physical_key']
        : []),
      ...(inputSignatureMatches === false
        ? [targetJudgment === null ? 'judgment_input_signature_mismatch' : 'judgment_physical_key_not_equivalent']
        : []),
      ...(visibleConflicts.length > 0 ? ['judgment_review_visible_natural_key_conflict'] : []),
      ...(fieldSignatureMatches ? [] : ['judgment_reused_benchmark_field_conflict']),
    ]
    const unresolved =
      targetModelId === null || input.dependencyResolution === undefined || input.dependencyResolution === null
    const action = conflictCodes.length > 0 ? 'blocked' : unresolved ? 'unknown' : targetJudgment ? 'reuse' : 'insert'

    return {
      action,
      conflictCodes,
      inputSignatureMatches,
      physicalKey,
      provenanceKind: getProvenanceKind(judgment, 'judgmentInputSignatureProvenance'),
      reviewVisibleKey,
      sourceJudgmentId,
      targetArticleId,
      targetJudgmentId:
        targetJudgment?.targetJudgmentId
        ?? (action === 'insert' || action === 'unknown' ? `new:judgment:${sourceJudgmentId}` : null),
      targetModelId,
      targetPromptId,
    }
  })

  return {duplicatePhysicalKeyBlockers, plan}
}

const getAssessmentPlan = async ({
  input,
  judgmentPlan,
}: {
  input: ProjectTransferFidelityValidationInput
  judgmentPlan: ProjectTransferJudgmentPlanEntry[]
}) => {
  const judgmentPlanBySource = judgmentPlan.reduce<Record<string, ProjectTransferJudgmentPlanEntry>>(
    (mapped, entry) => {
      return {...mapped, [entry.sourceJudgmentId]: entry}
    },
    {},
  )
  const targetAssessments = await getTargetJudgmentAssessmentRows({
    runner: input.runner,
    targetJudgmentIds: judgmentPlan
      .map((entry) => {
        return entry.targetJudgmentId
      })
      .filter((targetJudgmentId): targetJudgmentId is string => {
        return targetJudgmentId !== null
      }),
  })
  const targetAssessmentByJudgmentId = targetAssessments.reduce<Record<string, TargetJudgmentAssessmentRow>>(
    (mapped, assessment) => {
      return {...mapped, [assessment.targetJudgmentId]: assessment}
    },
    {},
  )
  const duplicateAssessmentBlockers = getDuplicateKeyBlockers({
    code: 'judgment_assessment_package_duplicate_key',
    entries: input.payloads.judgmentAssessments ?? [],
    getKey: (assessment) => {
      const targetJudgmentId = judgmentPlanBySource[getStringField(assessment, 'sourceJudgmentId')]?.targetJudgmentId

      return targetJudgmentId ?? null
    },
    getScope: (assessment) => {
      return `judgmentAssessments.${getStringField(assessment, 'sourceJudgmentAssessmentId')}`
    },
    message: 'Imported judgment assessments contain duplicate final judgment keys',
  })
  const duplicateAssessmentBlockerScopes = new Set(
    duplicateAssessmentBlockers.map((blocker) => {
      return blocker.scope
    }),
  )
  const plan = (input.payloads.judgmentAssessments ?? []).map(
    (assessment): ProjectTransferJudgmentAssessmentPlanEntry => {
      const sourceJudgmentAssessmentId = getStringField(assessment, 'sourceJudgmentAssessmentId')
      const sourceJudgmentId = getStringField(assessment, 'sourceJudgmentId')
      const targetJudgmentId = judgmentPlanBySource[sourceJudgmentId]?.targetJudgmentId ?? null
      const targetAssessment = targetJudgmentId ? (targetAssessmentByJudgmentId[targetJudgmentId] ?? null) : null
      const assessmentMatches =
        targetAssessment === null
          ? true
          : valuesEquivalent(getImportedAssessmentSignature(assessment), getTargetAssessmentSignature(targetAssessment))
      const conflictCodes = [
        ...(targetJudgmentId === null ? ['judgment_assessment_unique_key_unresolved'] : []),
        ...(duplicateAssessmentBlockerScopes.has(`judgmentAssessments.${sourceJudgmentAssessmentId}`)
          ? ['judgment_assessment_package_duplicate_key']
          : []),
        ...(assessmentMatches ? [] : ['judgment_reused_assessment_conflict']),
      ]

      return {
        action: conflictCodes.length > 0 ? 'blocked' : targetAssessment ? 'reuse' : 'insert',
        conflictCodes,
        sourceJudgmentAssessmentId,
        sourceJudgmentId,
        targetAssessmentId: targetAssessment?.targetAssessmentId ?? null,
        targetJudgmentId,
      }
    },
  )

  return {duplicateAssessmentBlockers, plan}
}

const getHumanReviewUniqueKey = ({
  kind,
  projectTargetId,
  targetArticleId,
  targetPromptId,
}: {
  kind: ProjectTransferHumanReviewPlanEntry['kind']
  projectTargetId: string | null
  targetArticleId: string | null
  targetPromptId: string | null
}) => {
  return projectTargetId === null || targetArticleId === null || (kind === 'humanJudgment' && targetPromptId === null)
    ? null
    : kind === 'humanJudgment'
      ? [projectTargetId, targetArticleId, targetPromptId].join(':')
      : [projectTargetId, targetArticleId].join(':')
}

const getHumanReviewRecords = (payloads: Partial<ProjectTransferPayloadByKey>) => {
  return [
    ...(payloads.humanJudgments ?? []).map((record) => {
      return {idField: 'sourceHumanJudgmentId', kind: 'humanJudgment' as const, record}
    }),
    ...(payloads.humanJudgmentSummaries ?? []).map((record) => {
      return {idField: 'sourceHumanJudgmentSummaryId', kind: 'humanJudgmentSummary' as const, record}
    }),
    ...(payloads.reviews ?? []).map((record) => {
      return {idField: 'sourceReviewId', kind: 'review' as const, record}
    }),
  ]
}

const getHumanReviewPlan = ({
  articleTargetIdBySource,
  input,
  promptTargetIdBySource,
}: {
  articleTargetIdBySource: Record<string, string | null>
  input: ProjectTransferFidelityValidationInput
  promptTargetIdBySource: Record<string, string | null>
}) => {
  const articleInputBySource = getArticleInputBySource({payloads: input.payloads, targetPlan: input.targetPlan})
  const promptInputBySource = getPromptInputBySource({payloads: input.payloads, targetPlan: input.targetPlan})
  const projectTargetId = getProjectTargetId(input.payloads)
  const duplicateKeyBlockers = getHumanReviewRecords(input.payloads)
    .reduce<
      Map<
        string,
        {idField: string; kind: ProjectTransferHumanReviewPlanEntry['kind']; record: ProjectTransferPayloadRecord}[]
      >
    >((mapped, row) => {
      const targetArticleId = articleTargetIdBySource[getStringField(row.record, 'sourceArticleId')] ?? null
      const targetPromptId = promptTargetIdBySource[getStringField(row.record, 'sourcePromptId')] ?? null
      const uniqueKey = getHumanReviewUniqueKey({kind: row.kind, projectTargetId, targetArticleId, targetPromptId})
      const mapKey = uniqueKey === null ? null : `${row.kind}:${uniqueKey}`
      const existing = mapKey === null ? [] : (mapped.get(mapKey) ?? [])

      return mapKey === null ? mapped : mapped.set(mapKey, [...existing, row])
    }, new Map())
    .values()
  const duplicateBlockers = [...duplicateKeyBlockers]
    .filter((group) => {
      return group.length > 1
    })
    .flatMap((group) => {
      return group.map((row) => {
        return getPlanBlocker({
          code:
            row.kind === 'humanJudgment'
              ? 'human_judgment_package_duplicate_key'
              : row.kind === 'humanJudgmentSummary'
                ? 'human_summary_package_duplicate_key'
                : 'review_package_duplicate_key',
          message: 'Imported human/review rows contain duplicate final unique keys',
          scope: `${row.kind}.${getStringField(row.record, row.idField)}`,
        })
      })
    })
  const duplicateScopes = new Set(
    duplicateBlockers.map((blocker) => {
      return blocker.scope
    }),
  )
  const plan = getHumanReviewRecords(input.payloads).map((row): ProjectTransferHumanReviewPlanEntry => {
    const sourceId = getStringField(row.record, row.idField)
    const targetArticleId = articleTargetIdBySource[getStringField(row.record, 'sourceArticleId')] ?? null
    const targetPromptId =
      row.kind === 'humanJudgment'
        ? (promptTargetIdBySource[getStringField(row.record, 'sourcePromptId')] ?? null)
        : null
    const uniqueKey = getHumanReviewUniqueKey({kind: row.kind, projectTargetId, targetArticleId, targetPromptId})
    const computedSignature = getHumanReviewSignature({
      articleInputBySource,
      promptInputBySource,
      record: row.record,
      type: row.kind,
    })
    const inputSignatureMatches =
      computedSignature === null ? null : valuesEquivalent(computedSignature, row.record.humanReviewInputSignature)
    const conflictCodes = [
      ...(uniqueKey === null ? ['human_review_unique_key_unresolved'] : []),
      ...(duplicateScopes.has(`${row.kind}.${sourceId}`)
        ? [
            row.kind === 'humanJudgment'
              ? 'human_judgment_package_duplicate_key'
              : row.kind === 'humanJudgmentSummary'
                ? 'human_summary_package_duplicate_key'
                : 'review_package_duplicate_key',
          ]
        : []),
      ...(inputSignatureMatches === false ? ['human_review_input_signature_mismatch'] : []),
    ]

    return {
      action: conflictCodes.length > 0 ? 'blocked' : 'insert',
      conflictCodes,
      inputSignatureMatches,
      kind: row.kind,
      provenanceKind: getProvenanceKind(row.record, 'humanReviewInputSignatureProvenance'),
      sourceId,
      targetArticleId,
      targetPromptId,
      uniqueKey,
    }
  })

  return {duplicateBlockers, plan}
}

export const getProjectTransferFidelityValidation = async (
  input: ProjectTransferFidelityValidationInput,
): Promise<ProjectTransferFidelityValidationResult> => {
  const articleTargetIdBySource = getArticleTargetIdBySource(input.targetPlan)
  const promptTargetIdBySource = getPromptTargetIdBySource(input.targetPlan)
  const modelTargetIdBySource = getModelTargetIdBySource({
    dependencyResolution: input.dependencyResolution,
    payloads: input.payloads,
  })
  const judgmentAnalysis = await getJudgmentPlan({
    articleTargetIdBySource,
    input,
    modelTargetIdBySource,
    promptTargetIdBySource,
  })
  const assessmentAnalysis = await getAssessmentPlan({input, judgmentPlan: judgmentAnalysis.plan})
  const humanReviewAnalysis = getHumanReviewPlan({articleTargetIdBySource, input, promptTargetIdBySource})
  const judgmentPlanBlockers = judgmentAnalysis.plan.flatMap((entry) => {
    return getBlockersForJudgmentPlanEntry({entry, sourceJudgmentId: entry.sourceJudgmentId})
  })
  const assessmentPlanBlockers = assessmentAnalysis.plan.flatMap((entry) => {
    return entry.conflictCodes.map((code) => {
      return getPlanBlocker({
        code,
        message: `${entry.sourceJudgmentAssessmentId} cannot be written against the final target judgment`,
        scope: `judgmentAssessments.${entry.sourceJudgmentAssessmentId}`,
      })
    })
  })
  const humanReviewPlanBlockers = humanReviewAnalysis.plan.flatMap(getBlockersForHumanReviewPlanEntry)
  const judgmentBlockers = [...judgmentPlanBlockers, ...assessmentPlanBlockers]
  const humanReviewBlockers = humanReviewPlanBlockers
  const hasUnknownJudgment = judgmentAnalysis.plan.some((entry) => {
    return entry.action === 'unknown'
  })
  const provenanceCounts = getSignatureProvenanceCounts(input.payloads)
  const reusedJudgmentCount = judgmentAnalysis.plan.filter((entry) => {
    return entry.action === 'reuse'
  }).length
  const judgmentConflictStatus = judgmentBlockers.length > 0 ? 'blocked' : hasUnknownJudgment ? 'unknown' : 'clear'

  return {
    blockers: [...judgmentBlockers, ...humanReviewBlockers],
    conflictCounts: {
      humanReviewFidelityConflictCount: humanReviewBlockers.length,
      judgmentConflictCount: judgmentBlockers.length,
    },
    judgmentConflictStatus,
    overlapCounts: {...provenanceCounts, reusedJudgmentCount},
    targetPlan: {
      humanReviewPlan: humanReviewAnalysis.plan,
      judgmentAssessmentPlan: assessmentAnalysis.plan,
      judgmentPlan: judgmentAnalysis.plan,
    },
  }
}
