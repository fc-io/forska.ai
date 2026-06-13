import {randomUUID} from 'node:crypto'

import {computePromptContentHash} from '../../utils/computePromptContentHash.ts'
import {getJsonValue, getQuotedStringList, getSqlLiteral} from '../appQueryHelpers.ts'
import type {ProjectTransferImportPlanArtifact} from './projectTransferAnalyze.ts'
import type {ProjectTransferTargetPlan} from './projectTransferAnalyzeTarget.ts'
import type {ProjectTransferCommitPromotionResult} from './projectTransferCommitRollback.ts'
import {getProjectTransferCanonicalJson} from './projectTransferFingerprint.ts'
import {getProjectTransferNormalizedArticleIdentifiers} from './projectTransferIdentifierNormalization.ts'
import type {
  ProjectTransferArticlePayloadRecord,
  ProjectTransferPayloadByKey,
  ProjectTransferPayloadRecord,
} from './projectTransferPayloadSchemas.ts'

export type ProjectTransferCommitIdMapKind =
  | 'article'
  | 'articleIdentifier'
  | 'articleImportRoute'
  | 'humanJudgment'
  | 'humanJudgmentSummary'
  | 'judgment'
  | 'judgmentAssessment'
  | 'model'
  | 'project'
  | 'projectArticle'
  | 'projectImportRoute'
  | 'projectPrompt'
  | 'prompt'
  | 'providerConnection'
  | 'review'
  | 'route'
  | 'transferHistory'

export type ProjectTransferCommitTargetTable =
  | 'article'
  | 'articleIdentifier'
  | 'articleImportRoute'
  | 'humanJudgment'
  | 'humanJudgmentSummary'
  | 'judgment'
  | 'judgmentAssessment'
  | 'model'
  | 'project'
  | 'projectArticle'
  | 'projectImportRoute'
  | 'projectPrompt'
  | 'prompt'
  | 'providerConnection'
  | 'review'
  | 'transferHistory'

export type ProjectTransferCommitIdMaps = {
  articleIdBySourceId: Record<string, string>
  articleIdentifierIdBySourceKey: Record<string, string>
  articleImportRouteIdBySourceId: Record<string, string>
  commitId: string
  generatedAt: string
  generatedTargetIds: Partial<Record<ProjectTransferCommitTargetTable, string[]>>
  humanJudgmentIdBySourceId: Record<string, string>
  humanJudgmentSummaryIdBySourceId: Record<string, string>
  judgmentAssessmentIdBySourceId: Record<string, string>
  judgmentIdBySourceId: Record<string, string>
  modelIdBySourceId: Record<string, string>
  projectArticleIdBySourceArticleId: Record<string, string>
  projectIdBySourceId: Record<string, string>
  projectImportRouteIdBySourceId: Record<string, string>
  projectPromptIdBySourceId: Record<string, string>
  promptIdBySourceId: Record<string, string>
  providerConnectionIdBySourceId: Record<string, string>
  routeIdBySourceId: Record<string, string>
  schemaVersion: 1
  transferHistoryId: string
  reviewIdBySourceId: Record<string, string>
}

export type ProjectTransferCommitIdMapTableSet = {idMap: string; operationId: string}

export type ProjectTransferCommitIdMapRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

const commitIdMapsSchemaVersion = 1

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getRecord = (value: unknown) => {
  return isRecord(value) ? value : {}
}

const getStringValue = (value: unknown) => {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

const getRequiredString = (value: unknown, label: string) => {
  const stringValue = getStringValue(value)

  if (stringValue === null) {
    throw new Error(`Project transfer commit id maps: ${label} is required`)
  }

  return stringValue
}

const getRecordField = (record: Record<string, unknown>, field: string) => {
  return Object.prototype.hasOwnProperty.call(record, field) ? record[field] : null
}

const getOperationId = (operationId: string) => {
  const identifier = operationId.replaceAll('-', '_').replace(/[^A-Za-z0-9_]/g, '_')

  return identifier === '' ? randomUUID().replaceAll('-', '_') : identifier
}

const getCommitIdMapTableName = (operationId: string) => {
  return `temp_project_transfer_${getOperationId(operationId)}_commit_id_map`
}

const getMapRecord = (value: unknown): Record<string, string> => {
  return isRecord(value)
    ? Object.entries(value).reduce<Record<string, string>>((mapped, [sourceId, targetId]) => {
        if (typeof targetId === 'string' && targetId.trim() !== '') {
          mapped[sourceId] = targetId
        }

        return mapped
      }, {})
    : {}
}

const getGeneratedTargetIds = (value: unknown): Partial<Record<ProjectTransferCommitTargetTable, string[]>> => {
  const record = getRecord(value)

  return Object.entries(record).reduce<Partial<Record<ProjectTransferCommitTargetTable, string[]>>>(
    (mapped, [table, ids]) => {
      const targetIds = Array.isArray(ids)
        ? ids.filter((id): id is string => {
            return typeof id === 'string' && id.trim() !== ''
          })
        : []

      if (targetIds.length !== 0) {
        mapped[table as ProjectTransferCommitTargetTable] = targetIds
      }

      return mapped
    },
    {},
  )
}

export const getProjectTransferCommitIdMaps = ({
  commitId,
  plan,
}: {
  commitId: string
  plan: ProjectTransferImportPlanArtifact
}): ProjectTransferCommitIdMaps | null => {
  const maps = getRecord((plan as {commitIdMaps?: unknown}).commitIdMaps)

  return maps.commitId === commitId && maps.schemaVersion === commitIdMapsSchemaVersion
    ? {
        articleIdBySourceId: getMapRecord(maps.articleIdBySourceId),
        articleIdentifierIdBySourceKey: getMapRecord(maps.articleIdentifierIdBySourceKey),
        articleImportRouteIdBySourceId: getMapRecord(maps.articleImportRouteIdBySourceId),
        commitId,
        generatedAt: getStringValue(maps.generatedAt) ?? new Date(0).toISOString(),
        generatedTargetIds: getGeneratedTargetIds(maps.generatedTargetIds),
        humanJudgmentIdBySourceId: getMapRecord(maps.humanJudgmentIdBySourceId),
        humanJudgmentSummaryIdBySourceId: getMapRecord(maps.humanJudgmentSummaryIdBySourceId),
        judgmentAssessmentIdBySourceId: getMapRecord(maps.judgmentAssessmentIdBySourceId),
        judgmentIdBySourceId: getMapRecord(maps.judgmentIdBySourceId),
        modelIdBySourceId: getMapRecord(maps.modelIdBySourceId),
        projectArticleIdBySourceArticleId: getMapRecord(maps.projectArticleIdBySourceArticleId),
        projectIdBySourceId: getMapRecord(maps.projectIdBySourceId),
        projectImportRouteIdBySourceId: getMapRecord(maps.projectImportRouteIdBySourceId),
        projectPromptIdBySourceId: getMapRecord(maps.projectPromptIdBySourceId),
        promptIdBySourceId: getMapRecord(maps.promptIdBySourceId),
        providerConnectionIdBySourceId: getMapRecord(maps.providerConnectionIdBySourceId),
        routeIdBySourceId: getMapRecord(maps.routeIdBySourceId),
        schemaVersion: commitIdMapsSchemaVersion,
        transferHistoryId: getStringValue(maps.transferHistoryId) ?? randomUUID(),
        reviewIdBySourceId: getMapRecord(maps.reviewIdBySourceId),
      }
    : null
}

const getDependencyResolutionRecord = (plan: ProjectTransferImportPlanArtifact) => {
  return isRecord(plan.dependencyResolution) ? plan.dependencyResolution : {}
}

const getDependencyResolutionMap = (plan: ProjectTransferImportPlanArtifact, key: string) => {
  return getMapRecord(getDependencyResolutionRecord(plan)[key])
}

const getImportedTargetProviderConnectionId = (sourceProviderConnectionId: string) => {
  return `new:provider:${sourceProviderConnectionId}`
}

const getImportedTargetModelId = (sourceModelId: string) => {
  return `new:model:${sourceModelId}`
}

const isImportedTargetProviderConnectionId = (targetProviderConnectionId: string) => {
  return targetProviderConnectionId.startsWith(getImportedTargetProviderConnectionId(''))
}

const isImportedTargetModelId = (targetModelId: string) => {
  return targetModelId.startsWith(getImportedTargetModelId(''))
}

const generatedId = ({
  generated,
  table,
  targetId,
}: {
  generated: Partial<Record<ProjectTransferCommitTargetTable, string[]>>
  table: ProjectTransferCommitTargetTable
  targetId: string
}) => {
  const targetIds = generated[table] ?? []
  targetIds.push(targetId)
  generated[table] = targetIds

  return targetId
}

const getGeneratedMapValue = ({
  existing,
  generated,
  sourceId,
  table,
}: {
  existing: Record<string, string>
  generated: Partial<Record<ProjectTransferCommitTargetTable, string[]>>
  sourceId: string
  table: ProjectTransferCommitTargetTable
}) => {
  const existingValue = existing[sourceId]

  return existingValue ?? generatedId({generated, table, targetId: randomUUID()})
}

const getProjectIdBySourceId = ({
  existing,
  generated,
  project,
}: {
  existing: Record<string, string>
  generated: Partial<Record<ProjectTransferCommitTargetTable, string[]>>
  project?: ProjectTransferPayloadByKey['project']
}) => {
  const sourceProjectId = getStringValue(getRecord(project ?? {}).sourceProjectId)

  return sourceProjectId === null
    ? {}
    : {[sourceProjectId]: getGeneratedMapValue({existing, generated, sourceId: sourceProjectId, table: 'project'})}
}

const getArticleIdBySourceId = ({
  articleMatches,
  existing,
  generated,
  promotion,
}: {
  articleMatches: readonly ProjectTransferTargetPlan['articleMatches'][number][]
  existing: Record<string, string>
  generated: Partial<Record<ProjectTransferCommitTargetTable, string[]>>
  promotion: ProjectTransferCommitPromotionResult
}) => {
  const createdArticleSources = new Set(
    promotion.articleCreates.map((entry) => {
      return entry.sourceArticleId
    }),
  )

  return articleMatches.reduce<Record<string, string>>((mapped, match) => {
    if (match.action === 'create' && createdArticleSources.has(match.sourceArticleId)) {
      mapped[match.sourceArticleId] = getGeneratedMapValue({
        existing,
        generated,
        sourceId: match.sourceArticleId,
        table: 'article',
      })

      return mapped
    }

    if (match.action === 'reuse' && match.selectedTargetArticleId !== null) {
      mapped[match.sourceArticleId] = match.selectedTargetArticleId
    }

    return mapped
  }, {})
}

const getRouteIdBySourceId = (projectRoutePlan: readonly ProjectTransferTargetPlan['projectRoutePlan'][number][]) => {
  return projectRoutePlan.reduce<Record<string, string>>((mapped, route) => {
    if (route.action === 'link' && route.targetImportRouteId !== null) {
      mapped[route.sourceImportRouteId] = route.targetImportRouteId
    }

    return mapped
  }, {})
}

const getArticleImportRouteIdBySourceId = ({
  articleRoutePlan,
  existing,
  generated,
}: {
  articleRoutePlan: readonly ProjectTransferTargetPlan['articleRoutePlan'][number][]
  existing: Record<string, string>
  generated: Partial<Record<ProjectTransferCommitTargetTable, string[]>>
}) => {
  return articleRoutePlan
    .filter((entry) => {
      return entry.action === 'write'
    })
    .reduce<Record<string, string>>((mapped, entry) => {
      mapped[entry.sourceArticleImportRouteId] = getGeneratedMapValue({
        existing,
        generated,
        sourceId: entry.sourceArticleImportRouteId,
        table: 'articleImportRoute',
      })

      return mapped
    }, {})
}

const getProjectImportRouteIdBySourceId = ({
  existing,
  generated,
  projectRoutePlan,
}: {
  existing: Record<string, string>
  generated: Partial<Record<ProjectTransferCommitTargetTable, string[]>>
  projectRoutePlan: readonly ProjectTransferTargetPlan['projectRoutePlan'][number][]
}) => {
  return projectRoutePlan
    .filter((entry) => {
      return entry.action === 'link'
    })
    .reduce<Record<string, string>>((mapped, entry) => {
      mapped[entry.sourceProjectImportRouteId] = getGeneratedMapValue({
        existing,
        generated,
        sourceId: entry.sourceProjectImportRouteId,
        table: 'projectImportRoute',
      })

      return mapped
    }, {})
}

const getProviderConnectionIdBySourceId = ({
  existing,
  generated,
  plan,
}: {
  existing: Record<string, string>
  generated: Partial<Record<ProjectTransferCommitTargetTable, string[]>>
  plan: ProjectTransferImportPlanArtifact
}) => {
  return Object.entries(getDependencyResolutionMap(plan, 'providerTargetBySourceId')).reduce<Record<string, string>>(
    (mapped, [sourceId, targetId]) => {
      mapped[sourceId] = isImportedTargetProviderConnectionId(targetId)
        ? getGeneratedMapValue({existing, generated, sourceId, table: 'providerConnection'})
        : targetId

      return mapped
    },
    {},
  )
}

const getModelIdBySourceId = ({
  existing,
  generated,
  plan,
}: {
  existing: Record<string, string>
  generated: Partial<Record<ProjectTransferCommitTargetTable, string[]>>
  plan: ProjectTransferImportPlanArtifact
}) => {
  return Object.entries(getDependencyResolutionMap(plan, 'modelTargetBySourceId')).reduce<Record<string, string>>(
    (mapped, [sourceId, targetId]) => {
      mapped[sourceId] = isImportedTargetModelId(targetId)
        ? getGeneratedMapValue({existing, generated, sourceId, table: 'model'})
        : targetId

      return mapped
    },
    {},
  )
}

const getPayloadMapBySourceId = ({
  existing,
  generated,
  records,
  sourceField,
  table,
}: {
  existing: Record<string, string>
  generated: Partial<Record<ProjectTransferCommitTargetTable, string[]>>
  records: readonly ProjectTransferPayloadRecord[]
  sourceField: string
  table: ProjectTransferCommitTargetTable
}) => {
  return records.reduce<Record<string, string>>((mapped, record) => {
    const sourceId = getStringValue(getRecordField(record, sourceField))

    if (sourceId !== null) {
      mapped[sourceId] = getGeneratedMapValue({existing, generated, sourceId, table})
    }

    return mapped
  }, {})
}

const getJudgmentIdBySourceId = ({
  existing,
  generated,
  judgmentPlan,
}: {
  existing: Record<string, string>
  generated: Partial<Record<ProjectTransferCommitTargetTable, string[]>>
  judgmentPlan: readonly NonNullable<ProjectTransferTargetPlan['judgmentPlan']>
}) => {
  return judgmentPlan.reduce<Record<string, string>>((mapped, entry) => {
    if (entry.action === 'insert') {
      mapped[entry.sourceJudgmentId] = getGeneratedMapValue({
        existing,
        generated,
        sourceId: entry.sourceJudgmentId,
        table: 'judgment',
      })

      return mapped
    }

    if (entry.action === 'reuse' && entry.targetJudgmentId !== null) {
      mapped[entry.sourceJudgmentId] = entry.targetJudgmentId
    }

    return mapped
  }, {})
}

const getJudgmentAssessmentIdBySourceId = ({
  existing,
  generated,
  judgmentAssessmentPlan,
}: {
  existing: Record<string, string>
  generated: Partial<Record<ProjectTransferCommitTargetTable, string[]>>
  judgmentAssessmentPlan: readonly NonNullable<ProjectTransferTargetPlan['judgmentAssessmentPlan']>
}) => {
  return judgmentAssessmentPlan.reduce<Record<string, string>>((mapped, entry) => {
    if (entry.action === 'insert') {
      mapped[entry.sourceJudgmentAssessmentId] = getGeneratedMapValue({
        existing,
        generated,
        sourceId: entry.sourceJudgmentAssessmentId,
        table: 'judgmentAssessment',
      })

      return mapped
    }

    if (entry.action === 'reuse' && entry.targetAssessmentId !== null) {
      mapped[entry.sourceJudgmentAssessmentId] = entry.targetAssessmentId
    }

    return mapped
  }, {})
}

const getHumanReviewIdBySourceId = ({
  existing,
  generated,
  humanReviewPlan,
  kind,
  table,
}: {
  existing: Record<string, string>
  generated: Partial<Record<ProjectTransferCommitTargetTable, string[]>>
  humanReviewPlan: readonly NonNullable<ProjectTransferTargetPlan['humanReviewPlan']>
  kind: NonNullable<ProjectTransferTargetPlan['humanReviewPlan']>[number]['kind']
  table: ProjectTransferCommitTargetTable
}) => {
  return humanReviewPlan
    .filter((entry) => {
      return entry.kind === kind && entry.action === 'insert'
    })
    .reduce<Record<string, string>>((mapped, entry) => {
      mapped[entry.sourceId] = getGeneratedMapValue({existing, generated, sourceId: entry.sourceId, table})

      return mapped
    }, {})
}

const getProjectArticleIdBySourceArticleId = ({
  articleRoutePlan,
  existing,
  generated,
  projectArticles,
}: {
  articleRoutePlan: readonly ProjectTransferTargetPlan['articleRoutePlan'][number][]
  existing: Record<string, string>
  generated: Partial<Record<ProjectTransferCommitTargetTable, string[]>>
  projectArticles: readonly ProjectTransferPayloadRecord[]
}) => {
  const projectArticleSources = projectArticles.map((entry) => {
    return getRequiredString(getRecordField(entry, 'sourceArticleId'), 'projectArticle.sourceArticleId')
  })
  const snapshotArticleSources = articleRoutePlan
    .filter((entry) => {
      return entry.snapshotProjectArticleLink
    })
    .map((entry) => {
      return entry.sourceArticleId
    })
  const sourceArticleIds = [...new Set([...projectArticleSources, ...snapshotArticleSources])]

  return sourceArticleIds.reduce<Record<string, string>>((mapped, sourceId) => {
    mapped[sourceId] = getGeneratedMapValue({existing, generated, sourceId, table: 'projectArticle'})

    return mapped
  }, {})
}

const getArticleIdentifierSourceKey = ({
  kind,
  normalizedValue,
  sourceArticleId,
}: {
  kind: string
  normalizedValue: string
  sourceArticleId: string
}) => {
  return getProjectTransferCanonicalJson({kind, normalizedValue, sourceArticleId})
}

const getArticleIdentifierIdBySourceKey = ({
  articles,
  existing,
  generated,
}: {
  articles: readonly ProjectTransferArticlePayloadRecord[]
  existing: Record<string, string>
  generated: Partial<Record<ProjectTransferCommitTargetTable, string[]>>
}) => {
  return articles.reduce<Record<string, string>>((mapped, article) => {
    const identifiers = getProjectTransferNormalizedArticleIdentifiers(article).strongIdentifiers
    identifiers.reduce<Record<string, string>>((identifierMap, identifier) => {
      const sourceKey = getArticleIdentifierSourceKey({
        kind: identifier.kind,
        normalizedValue: identifier.normalizedValue,
        sourceArticleId: article.sourceArticleId,
      })

      identifierMap[sourceKey] = getGeneratedMapValue({
        existing,
        generated,
        sourceId: sourceKey,
        table: 'articleIdentifier',
      })

      return identifierMap
    }, mapped)

    return mapped
  }, {})
}

const getProjectTransferCommitIdMapsGeneratedTargetIds = (
  maps: ProjectTransferCommitIdMaps,
): Partial<Record<ProjectTransferCommitTargetTable, string[]>> => {
  const generatedEntries = Object.entries(maps.generatedTargetIds).map(([table, ids]) => {
    const uniqueIds = [...new Set(ids ?? [])]

    return [table, uniqueIds] as const
  })

  return generatedEntries.reduce<Partial<Record<ProjectTransferCommitTargetTable, string[]>>>(
    (mapped, [table, ids]) => {
      if (ids.length !== 0) {
        mapped[table as ProjectTransferCommitTargetTable] = ids
      }

      return mapped
    },
    {},
  )
}

export const getProjectTransferPlanWithCommitIdMaps = ({
  commitId,
  now,
  payloads,
  plan,
  promotion,
}: {
  commitId: string
  now: Date
  payloads: Partial<ProjectTransferPayloadByKey>
  plan: ProjectTransferImportPlanArtifact
  promotion: ProjectTransferCommitPromotionResult
}): ProjectTransferImportPlanArtifact & {commitIdMaps: ProjectTransferCommitIdMaps} => {
  const existing = getProjectTransferCommitIdMaps({commitId, plan})

  if (existing !== null) {
    return {...plan, commitIdMaps: existing}
  }

  const generated: Partial<Record<ProjectTransferCommitTargetTable, string[]>> = {}
  const emptyMaps = {
    articleIdBySourceId: {},
    articleIdentifierIdBySourceKey: {},
    articleImportRouteIdBySourceId: {},
    humanJudgmentIdBySourceId: {},
    humanJudgmentSummaryIdBySourceId: {},
    judgmentAssessmentIdBySourceId: {},
    judgmentIdBySourceId: {},
    modelIdBySourceId: {},
    projectArticleIdBySourceArticleId: {},
    projectIdBySourceId: {},
    projectImportRouteIdBySourceId: {},
    projectPromptIdBySourceId: {},
    promptIdBySourceId: {},
    providerConnectionIdBySourceId: {},
    routeIdBySourceId: {},
    reviewIdBySourceId: {},
  } satisfies Omit<
    ProjectTransferCommitIdMaps,
    'commitId' | 'generatedAt' | 'generatedTargetIds' | 'schemaVersion' | 'transferHistoryId'
  >
  const maps = {
    ...emptyMaps,
    articleIdBySourceId: getArticleIdBySourceId({
      articleMatches: plan.targetPlan.articleMatches,
      existing: {},
      generated,
      promotion,
    }),
    articleIdentifierIdBySourceKey: getArticleIdentifierIdBySourceKey({
      articles: payloads.articles ?? [],
      existing: {},
      generated,
    }),
    articleImportRouteIdBySourceId: getArticleImportRouteIdBySourceId({
      articleRoutePlan: plan.targetPlan.articleRoutePlan,
      existing: {},
      generated,
    }),
    commitId,
    generatedAt: now.toISOString(),
    generatedTargetIds: generated,
    humanJudgmentIdBySourceId: getHumanReviewIdBySourceId({
      existing: {},
      generated,
      humanReviewPlan: plan.targetPlan.humanReviewPlan ?? [],
      kind: 'humanJudgment',
      table: 'humanJudgment',
    }),
    humanJudgmentSummaryIdBySourceId: getHumanReviewIdBySourceId({
      existing: {},
      generated,
      humanReviewPlan: plan.targetPlan.humanReviewPlan ?? [],
      kind: 'humanJudgmentSummary',
      table: 'humanJudgmentSummary',
    }),
    judgmentAssessmentIdBySourceId: getJudgmentAssessmentIdBySourceId({
      existing: {},
      generated,
      judgmentAssessmentPlan: plan.targetPlan.judgmentAssessmentPlan ?? [],
    }),
    judgmentIdBySourceId: getJudgmentIdBySourceId({
      existing: {},
      generated,
      judgmentPlan: plan.targetPlan.judgmentPlan ?? [],
    }),
    modelIdBySourceId: getModelIdBySourceId({existing: {}, generated, plan}),
    projectArticleIdBySourceArticleId: getProjectArticleIdBySourceArticleId({
      articleRoutePlan: plan.targetPlan.articleRoutePlan,
      existing: {},
      generated,
      projectArticles: payloads.projectArticles ?? [],
    }),
    projectIdBySourceId: getProjectIdBySourceId({existing: {}, generated, project: payloads.project}),
    projectImportRouteIdBySourceId: getProjectImportRouteIdBySourceId({
      existing: {},
      generated,
      projectRoutePlan: plan.targetPlan.projectRoutePlan,
    }),
    projectPromptIdBySourceId: getPayloadMapBySourceId({
      existing: {},
      generated,
      records: payloads.projectPrompts ?? [],
      sourceField: 'sourceProjectPromptId',
      table: 'projectPrompt',
    }),
    promptIdBySourceId: getPayloadMapBySourceId({
      existing: {},
      generated,
      records: payloads.prompts ?? [],
      sourceField: 'sourcePromptId',
      table: 'prompt',
    }),
    providerConnectionIdBySourceId: getProviderConnectionIdBySourceId({existing: {}, generated, plan}),
    routeIdBySourceId: getRouteIdBySourceId(plan.targetPlan.projectRoutePlan),
    schemaVersion: commitIdMapsSchemaVersion,
    transferHistoryId: generatedId({generated, table: 'transferHistory', targetId: randomUUID()}),
    reviewIdBySourceId: getHumanReviewIdBySourceId({
      existing: {},
      generated,
      humanReviewPlan: plan.targetPlan.humanReviewPlan ?? [],
      kind: 'review',
      table: 'review',
    }),
  } satisfies ProjectTransferCommitIdMaps

  return {...plan, commitIdMaps: {...maps, generatedTargetIds: getProjectTransferCommitIdMapsGeneratedTargetIds(maps)}}
}

const getMapEntries = ({kind, mapped}: {kind: ProjectTransferCommitIdMapKind; mapped: Record<string, string>}) => {
  return Object.entries(mapped).map(([sourceId, targetId]) => {
    return {kind, sourceId, targetId}
  })
}

const getProjectEntry = (maps: ProjectTransferCommitIdMaps) => {
  const sourceId = Object.keys(maps.projectIdBySourceId)[0] ?? null
  const targetId = sourceId === null ? null : (maps.projectIdBySourceId[sourceId] ?? null)

  return sourceId === null || targetId === null ? [] : [{kind: 'project' as const, sourceId, targetId}]
}

const getTransferHistoryEntry = (maps: ProjectTransferCommitIdMaps) => {
  return [{kind: 'transferHistory' as const, sourceId: maps.commitId, targetId: maps.transferHistoryId}]
}

const getCommitIdMapEntries = (maps: ProjectTransferCommitIdMaps) => {
  return [
    ...getMapEntries({kind: 'article', mapped: maps.articleIdBySourceId}),
    ...getMapEntries({kind: 'articleIdentifier', mapped: maps.articleIdentifierIdBySourceKey}),
    ...getMapEntries({kind: 'articleImportRoute', mapped: maps.articleImportRouteIdBySourceId}),
    ...getMapEntries({kind: 'humanJudgment', mapped: maps.humanJudgmentIdBySourceId}),
    ...getMapEntries({kind: 'humanJudgmentSummary', mapped: maps.humanJudgmentSummaryIdBySourceId}),
    ...getMapEntries({kind: 'judgment', mapped: maps.judgmentIdBySourceId}),
    ...getMapEntries({kind: 'judgmentAssessment', mapped: maps.judgmentAssessmentIdBySourceId}),
    ...getMapEntries({kind: 'model', mapped: maps.modelIdBySourceId}),
    ...getProjectEntry(maps),
    ...getMapEntries({kind: 'projectArticle', mapped: maps.projectArticleIdBySourceArticleId}),
    ...getMapEntries({kind: 'projectImportRoute', mapped: maps.projectImportRouteIdBySourceId}),
    ...getMapEntries({kind: 'projectPrompt', mapped: maps.projectPromptIdBySourceId}),
    ...getMapEntries({kind: 'prompt', mapped: maps.promptIdBySourceId}),
    ...getMapEntries({kind: 'providerConnection', mapped: maps.providerConnectionIdBySourceId}),
    ...getMapEntries({kind: 'review', mapped: maps.reviewIdBySourceId}),
    ...getMapEntries({kind: 'route', mapped: maps.routeIdBySourceId}),
    ...getTransferHistoryEntry(maps),
  ]
}

const getCommitIdMapRowsSql = (maps: ProjectTransferCommitIdMaps) => {
  const entries = getCommitIdMapEntries(maps)

  return entries.length === 0
    ? ''
    : entries
        .map((entry) => {
          return `(${getSqlLiteral(entry.kind)}, ${getSqlLiteral(entry.sourceId)}, ${getSqlLiteral(entry.targetId)})`
        })
        .join(', ')
}

export const loadProjectTransferCommitIdMapTables = async ({
  maps,
  operationId,
  runner,
}: {
  maps: ProjectTransferCommitIdMaps
  operationId: string
  runner: ProjectTransferCommitIdMapRunner
}): Promise<ProjectTransferCommitIdMapTableSet> => {
  const tables = {idMap: getCommitIdMapTableName(operationId), operationId: getOperationId(operationId)}
  const rowsSql = getCommitIdMapRowsSql(maps)

  await runner.run(`
    DROP TABLE IF EXISTS ${tables.idMap};
    CREATE TEMP TABLE ${tables.idMap} (
      map_kind VARCHAR NOT NULL,
      source_id VARCHAR NOT NULL,
      target_id VARCHAR NOT NULL
    );
    ${
      rowsSql === ''
        ? ''
        : `INSERT INTO ${tables.idMap} (map_kind, source_id, target_id)
           VALUES ${rowsSql};`
    }
  `)

  return tables
}

export const dropProjectTransferCommitIdMapTables = async ({
  runner,
  tables,
}: {
  runner: ProjectTransferCommitIdMapRunner
  tables: ProjectTransferCommitIdMapTableSet
}) => {
  await runner.run(`DROP TABLE IF EXISTS ${tables.idMap}`)
}

const targetTableNameByGeneratedIdTable = {
  article: 'app.article',
  articleIdentifier: 'app.article_identifier',
  articleImportRoute: 'app.article_import_route',
  humanJudgment: 'app.judgment_human',
  humanJudgmentSummary: 'app.judgment_human_summary',
  judgment: 'app.judgment',
  judgmentAssessment: 'app.judgment_assessment',
  model: 'app.model',
  project: 'app.project',
  projectArticle: 'app.project_article',
  projectImportRoute: 'app.project_import_route',
  projectPrompt: 'app.project_prompt',
  prompt: 'app.prompt',
  providerConnection: 'app.provider_connection',
  review: 'app.review',
  transferHistory: 'app.project_transfer_history',
} as const satisfies Record<ProjectTransferCommitTargetTable, string>

const assertNoDuplicateGeneratedTargetIds = (maps: ProjectTransferCommitIdMaps) => {
  const allIds = Object.values(maps.generatedTargetIds).flatMap((ids) => {
    return ids ?? []
  })
  const seen = new Set<string>()
  const duplicate = allIds.find((id) => {
    const alreadySeen = seen.has(id)

    if (!alreadySeen) {
      seen.add(id)
    }

    return alreadySeen
  })

  if (duplicate !== undefined) {
    throw new Error(`Project transfer commit id maps: duplicate generated target id ${duplicate}`)
  }
}

export const assertProjectTransferCommitGeneratedIdsAvailable = async ({
  maps,
  runner,
}: {
  maps: ProjectTransferCommitIdMaps
  runner: ProjectTransferCommitIdMapRunner
}) => {
  assertNoDuplicateGeneratedTargetIds(maps)

  await Object.entries(maps.generatedTargetIds).reduce<Promise<void>>(async (previous, [table, ids]) => {
    await previous
    const targetIds = [...new Set(ids ?? [])]
    const tableName = targetTableNameByGeneratedIdTable[table as ProjectTransferCommitTargetTable]

    if (targetIds.length === 0) {
      return undefined
    }

    const rows = await runner.queryJson<{id: string}>(`
      SELECT id
      FROM ${tableName}
      WHERE id IN (${getQuotedStringList(targetIds).join(', ')})
      ORDER BY id ASC
      LIMIT 1
    `)
    const conflict = rows[0]

    if (conflict !== undefined) {
      throw new Error(`Project transfer commit id maps: generated ${table} target id already exists: ${conflict.id}`)
    }

    return undefined
  }, Promise.resolve())
}

const getPromptContentHash = (prompt: ProjectTransferPayloadRecord) => {
  const sourcePromptId = getRequiredString(getRecordField(prompt, 'sourcePromptId'), 'prompt.sourcePromptId')

  return {
    contentHash: computePromptContentHash(
      getRequiredString(getRecordField(prompt, 'originalText'), `prompts.${sourcePromptId}.originalText`),
      getStringValue(getRecordField(prompt, 'transformedText')),
      getStringValue(getRecordField(prompt, 'promptHeading')),
      getStringValue(getRecordField(prompt, 'type')),
    ),
    sourcePromptId,
  }
}

export const getProjectTransferPromptContentHashBySourceId = (prompts: readonly ProjectTransferPayloadRecord[]) => {
  return prompts.reduce<Record<string, string>>((mapped, prompt) => {
    const entry = getPromptContentHash(prompt)

    mapped[entry.sourcePromptId] = entry.contentHash

    return mapped
  }, {})
}

export const getProjectTransferCommitMapsWithPromptTargets = ({
  contentHashTargetIdBySourceId,
  generatedPromptIds,
  maps,
}: {
  contentHashTargetIdBySourceId: Record<string, string>
  generatedPromptIds: readonly string[]
  maps: ProjectTransferCommitIdMaps
}) => {
  const generatedTargetIds = {...maps.generatedTargetIds, prompt: [...generatedPromptIds]}

  return {
    ...maps,
    generatedTargetIds: getProjectTransferCommitIdMapsGeneratedTargetIds({...maps, generatedTargetIds}),
    promptIdBySourceId: contentHashTargetIdBySourceId,
  } satisfies ProjectTransferCommitIdMaps
}

export const getProjectTransferCommitMapsWithDependencyTargets = ({
  generatedModelIds,
  generatedProviderConnectionIds,
  maps,
  modelIdBySourceId,
  providerConnectionIdBySourceId,
}: {
  generatedModelIds: readonly string[]
  generatedProviderConnectionIds: readonly string[]
  maps: ProjectTransferCommitIdMaps
  modelIdBySourceId: Record<string, string>
  providerConnectionIdBySourceId: Record<string, string>
}) => {
  const generatedTargetIds = {
    ...maps.generatedTargetIds,
    model: [...generatedModelIds],
    providerConnection: [...generatedProviderConnectionIds],
  }

  return {
    ...maps,
    generatedTargetIds: getProjectTransferCommitIdMapsGeneratedTargetIds({...maps, generatedTargetIds}),
    modelIdBySourceId,
    providerConnectionIdBySourceId,
  } satisfies ProjectTransferCommitIdMaps
}

export const parseProjectTransferCommitIdMapJsonValue = (value: unknown) => {
  return getJsonValue(value)
}
