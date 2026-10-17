import {expect, test} from 'bun:test'

import {type FullTextStrategy, getFullTextStrategy} from '../../fullText/fullTextStrategy.ts'
import type {ProjectTransferTargetPlan} from './projectTransferAnalyzeTarget.ts'
import {
  getProjectTransferFidelityValidation,
  getProjectTransferJudgmentAnalysisFieldSignatureDigest,
  getProjectTransferJudgmentAnalysisInputSignatureDigest,
  projectTransferJudgmentAnalysisFieldSignatureDigestField,
  projectTransferJudgmentAnalysisInputSignatureDigestField,
} from './projectTransferFidelityValidation.ts'
import {
  getProjectTransferPayloadFixtureMap,
  type ProjectTransferPayloadRecord,
} from './projectTransferPayloadSchemas.ts'

const getBaseTargetPlan = (): ProjectTransferTargetPlan => {
  return {
    articleMatches: [
      {
        action: 'reuse',
        candidates: [],
        conflicts: [],
        identifierKeys: [],
        packageArticleId: null,
        selectedTargetArticleId: 'target-article-1',
        sourceArticleId: 'article-1',
      },
    ],
    articleRoutePlan: [],
    articleUpdatePlan: [],
    assetPromotionPlan: [],
    duplicateImportMatches: [],
    projectPromptPlan: [],
    projectRoutePlan: [],
    promptPlan: [
      {
        action: 'reuse',
        computedContentHash: 'c4f659c8baf0066f65ecb7006731b24d',
        packageContentHash: 'c4f659c8baf0066f65ecb7006731b24d',
        sourcePromptId: 'prompt-1',
        targetPromptId: 'target-prompt-1',
      },
    ],
  }
}

const getCompactAnalysisJudgment = (judgment: ProjectTransferPayloadRecord): ProjectTransferPayloadRecord => {
  return {
    chunkingStrategy: judgment.chunkingStrategy,
    contentSettings: judgment.contentSettings,
    deleteGeneration: judgment.deleteGeneration,
    judgmentInputSignatureProvenance: judgment.judgmentInputSignatureProvenance,
    [projectTransferJudgmentAnalysisFieldSignatureDigestField]:
      getProjectTransferJudgmentAnalysisFieldSignatureDigest(judgment),
    [projectTransferJudgmentAnalysisInputSignatureDigestField]: getProjectTransferJudgmentAnalysisInputSignatureDigest(
      judgment.judgmentInputSignature,
    ),
    sourceArticleId: judgment.sourceArticleId,
    sourceJudgmentId: judgment.sourceJudgmentId,
    sourceModelId: judgment.sourceModelId,
    sourcePromptId: judgment.sourcePromptId,
  } as unknown as ProjectTransferPayloadRecord
}

test('judgment review-visible keys preserve distinct content settings', async () => {
  const payloads = {
    ...getProjectTransferPayloadFixtureMap(),
    humanJudgmentSummaries: [],
    humanJudgments: [],
    judgmentAssessments: [],
    reviews: [],
  }
  const result = await getProjectTransferFidelityValidation({
    dependencyResolution: {
      modelTargetBySourceId: {'model-1': 'target-model-1'},
      providerTargetBySourceId: {'provider-connection-1': 'target-provider-1'},
    },
    payloads,
    runner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        const rows = statement.includes('FROM app.judgment')
          ? [
              {
                answeredOriginal: 'include',
                answeredOriginalAsArray: ['include'],
                confidenceOriginal: 90,
                deleteGeneration: 0,
                explanation: 'Existing title-only judgment',
                fullTextStrategyId: 'fts-none',
                isAnswered: true,
                quotes: [{quote: 'Fixture quote'}],
                targetArticleId: 'target-article-1',
                targetJudgmentId: 'target-title-only-judgment',
                targetModelId: 'target-model-1',
                targetPromptId: 'target-prompt-1',
                useAbstract: false,
                useFulltext: false,
                useFulltextNoImages: false,
                useMetadata: false,
                useTitle: true,
              },
            ]
          : []

        return rows as T[]
      },
    },
    targetPlan: getBaseTargetPlan(),
  })
  const [judgmentPlan] = result.targetPlan.judgmentPlan

  expect(judgmentPlan?.action).toBe('insert')
  expect(judgmentPlan?.conflictCodes).not.toContain('judgment_review_visible_natural_key_conflict')
  expect(judgmentPlan?.reviewVisibleKey).toBe(
    'target-article-1|target-prompt-1|target-model-1|true|true|false|false|false|legacy|fts-none',
  )
  expect(result.conflictCounts.judgmentConflictCount).toBe(0)
})

test('reused judgments treat TO_JSON database fields as equivalent arrays', async () => {
  const payloads = {
    ...getProjectTransferPayloadFixtureMap(),
    humanJudgmentSummaries: [],
    humanJudgments: [],
    judgmentAssessments: [],
    reviews: [],
  }
  const [importedJudgment] = payloads.judgments

  if (!importedJudgment) {
    throw new Error('Expected judgment fixture')
  }

  const result = await getProjectTransferFidelityValidation({
    dependencyResolution: {
      modelTargetBySourceId: {'model-1': 'target-model-1'},
      providerTargetBySourceId: {'provider-connection-1': 'target-provider-1'},
    },
    payloads,
    runner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        const rows = statement.includes('FROM app.judgment')
          ? [
              {
                answeredOriginal: importedJudgment.answeredOriginal,
                answeredOriginalAsArray: JSON.stringify(importedJudgment.answeredOriginalAsArray ?? []),
                confidenceOriginal: importedJudgment.confidenceOriginal,
                deleteGeneration: Number(importedJudgment.deleteGeneration ?? 0),
                explanation: importedJudgment.explanation,
                fullTextStrategyId: 'fts-none',
                isAnswered: importedJudgment.isAnswered,
                quotes: JSON.stringify(importedJudgment.quotes ?? []),
                targetArticleId: 'target-article-1',
                targetJudgmentId: 'target-judgment-1',
                targetModelId: 'target-model-1',
                targetPromptId: 'target-prompt-1',
                useAbstract: true,
                useFulltext: false,
                useFulltextNoImages: false,
                useMetadata: false,
                useTitle: true,
              },
            ]
          : []

        return rows as T[]
      },
    },
    targetPlan: getBaseTargetPlan(),
  })
  const [judgmentPlan] = result.targetPlan.judgmentPlan

  expect(judgmentPlan?.action).toBe('reuse')
  expect(judgmentPlan?.conflictCodes).toEqual([])
  expect(result.conflictCounts.judgmentConflictCount).toBe(0)
})

test('compact analysis judgment digests preserve input and saved-field fidelity checks', async () => {
  const fixturePayloads = getProjectTransferPayloadFixtureMap()
  const [importedJudgment] = fixturePayloads.judgments

  if (!importedJudgment) {
    throw new Error('Expected judgment fixture')
  }

  const payloads = {
    ...fixturePayloads,
    humanJudgmentSummaries: [],
    humanJudgments: [],
    judgmentAssessments: [],
    judgments: [getCompactAnalysisJudgment(importedJudgment)],
    reviews: [],
  }
  const result = await getProjectTransferFidelityValidation({
    dependencyResolution: {
      modelTargetBySourceId: {'model-1': 'target-model-1'},
      providerTargetBySourceId: {'provider-connection-1': 'target-provider-1'},
    },
    payloads,
    runner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        const rows = statement.includes('FROM app.judgment')
          ? [
              {
                answeredOriginal: importedJudgment.answeredOriginal,
                answeredOriginalAsArray: JSON.stringify(importedJudgment.answeredOriginalAsArray ?? []),
                confidenceOriginal: importedJudgment.confidenceOriginal,
                deleteGeneration: Number(importedJudgment.deleteGeneration ?? 0),
                explanation: importedJudgment.explanation,
                fullTextStrategyId: 'fts-none',
                isAnswered: importedJudgment.isAnswered,
                quotes: JSON.stringify(importedJudgment.quotes ?? []),
                targetArticleId: 'target-article-1',
                targetJudgmentId: 'target-judgment-1',
                targetModelId: 'target-model-1',
                targetPromptId: 'target-prompt-1',
                useAbstract: true,
                useFulltext: false,
                useFulltextNoImages: false,
                useMetadata: false,
                useTitle: true,
              },
            ]
          : []

        return rows as T[]
      },
    },
    targetPlan: getBaseTargetPlan(),
  })
  const [judgmentPlan] = result.targetPlan.judgmentPlan

  expect(judgmentPlan?.action).toBe('reuse')
  expect(judgmentPlan?.inputSignatureMatches).toBe(true)
  expect(judgmentPlan?.conflictCodes).toEqual([])
})

test('imported model placeholders detect judgments that already exist under the materialized source model id', async () => {
  const payloads = {
    ...getProjectTransferPayloadFixtureMap(),
    humanJudgmentSummaries: [],
    humanJudgments: [],
    judgmentAssessments: [],
    reviews: [],
  }
  const [importedJudgment] = payloads.judgments

  if (!importedJudgment) {
    throw new Error('Expected judgment fixture')
  }

  const result = await getProjectTransferFidelityValidation({
    dependencyResolution: {
      modelTargetBySourceId: {'model-1': 'new:model:model-1'},
      providerTargetBySourceId: {'provider-connection-1': 'new:provider:provider-connection-1'},
    },
    payloads,
    runner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        const rows = statement.includes('FROM app.judgment')
          ? [
              {
                answeredOriginal: importedJudgment.answeredOriginal,
                answeredOriginalAsArray: JSON.stringify(importedJudgment.answeredOriginalAsArray ?? []),
                confidenceOriginal: importedJudgment.confidenceOriginal,
                deleteGeneration: Number(importedJudgment.deleteGeneration ?? 0),
                explanation: importedJudgment.explanation,
                fullTextStrategyId: 'fts-none',
                isAnswered: importedJudgment.isAnswered,
                quotes: JSON.stringify(importedJudgment.quotes ?? []),
                targetArticleId: 'target-article-1',
                targetJudgmentId: 'target-judgment-1',
                targetModelId: 'model-1',
                targetPromptId: 'target-prompt-1',
                useAbstract: true,
                useFulltext: false,
                useFulltextNoImages: false,
                useMetadata: false,
                useTitle: true,
              },
            ]
          : []

        return rows as T[]
      },
    },
    targetPlan: getBaseTargetPlan(),
  })
  const [judgmentPlan] = result.targetPlan.judgmentPlan

  expect(judgmentPlan?.action).toBe('reuse')
  expect(judgmentPlan?.targetJudgmentId).toBe('target-judgment-1')
  expect(judgmentPlan?.targetModelId).toBe('model-1')
  expect(judgmentPlan?.physicalKey).toBe(
    'target-article-1|target-prompt-1|model-1|true|true|false|false|false|legacy|fts-none|0',
  )
  expect(judgmentPlan?.conflictCodes).toEqual([])
  expect(result.conflictCounts.judgmentConflictCount).toBe(0)
})

test('imported model placeholders detect review-visible conflicts under the materialized source model id', async () => {
  const payloads = {
    ...getProjectTransferPayloadFixtureMap(),
    humanJudgmentSummaries: [],
    humanJudgments: [],
    judgmentAssessments: [],
    reviews: [],
  }
  const [importedJudgment] = payloads.judgments

  if (!importedJudgment) {
    throw new Error('Expected judgment fixture')
  }

  const result = await getProjectTransferFidelityValidation({
    dependencyResolution: {
      modelTargetBySourceId: {'model-1': 'new:model:model-1'},
      providerTargetBySourceId: {'provider-connection-1': 'new:provider:provider-connection-1'},
    },
    payloads,
    runner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        const rows = statement.includes('FROM app.judgment')
          ? [
              {
                answeredOriginal: importedJudgment.answeredOriginal,
                answeredOriginalAsArray: JSON.stringify(importedJudgment.answeredOriginalAsArray ?? []),
                confidenceOriginal: importedJudgment.confidenceOriginal,
                deleteGeneration: 1,
                explanation: importedJudgment.explanation,
                fullTextStrategyId: 'fts-none',
                isAnswered: importedJudgment.isAnswered,
                quotes: JSON.stringify(importedJudgment.quotes ?? []),
                targetArticleId: 'target-article-1',
                targetJudgmentId: 'target-judgment-1',
                targetModelId: 'model-1',
                targetPromptId: 'target-prompt-1',
                useAbstract: true,
                useFulltext: false,
                useFulltextNoImages: false,
                useMetadata: false,
                useTitle: true,
              },
            ]
          : []

        return rows as T[]
      },
    },
    targetPlan: getBaseTargetPlan(),
  })
  const [judgmentPlan] = result.targetPlan.judgmentPlan

  expect(judgmentPlan?.action).toBe('blocked')
  expect(judgmentPlan?.conflictCodes).toContain('judgment_review_visible_natural_key_conflict')
  expect(result.conflictCounts.judgmentConflictCount).toBe(1)
})

test('reused judgment field conflicts explain differing saved judgment content clearly', async () => {
  const payloads = {
    ...getProjectTransferPayloadFixtureMap(),
    humanJudgmentSummaries: [],
    humanJudgments: [],
    judgmentAssessments: [],
    reviews: [],
  }
  const result = await getProjectTransferFidelityValidation({
    dependencyResolution: {
      modelTargetBySourceId: {'model-1': 'target-model-1'},
      providerTargetBySourceId: {'provider-connection-1': 'target-provider-1'},
    },
    payloads,
    runner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        const rows = statement.includes('FROM app.judgment')
          ? [
              {
                answeredOriginal: 'exclude',
                answeredOriginalAsArray: '["exclude"]',
                confidenceOriginal: 20,
                deleteGeneration: 0,
                explanation: 'Conflicting saved explanation.',
                fullTextStrategyId: 'fts-none',
                isAnswered: true,
                quotes: '[]',
                targetArticleId: 'target-article-1',
                targetJudgmentId: 'target-judgment-1',
                targetModelId: 'target-model-1',
                targetPromptId: 'target-prompt-1',
                useAbstract: true,
                useFulltext: false,
                useFulltextNoImages: false,
                useMetadata: false,
                useTitle: true,
              },
            ]
          : []

        return rows as T[]
      },
    },
    targetPlan: getBaseTargetPlan(),
  })
  const blocker = result.blockers.find((entry) => {
    return entry.code === 'judgment_reused_benchmark_field_conflict'
  })

  expect(result.targetPlan.judgmentPlan?.[0]?.conflictCodes).toContain('judgment_reused_benchmark_field_conflict')
  expect(blocker).toEqual({
    code: 'judgment_reused_benchmark_field_conflict',
    message:
      'judgment-1 matches an existing target judgment, but its saved answer, confidence, explanation, or quotes differ from the imported judgment',
    resolutionKind: 'requires_new_package_or_target_changes',
    scope: 'judgments.judgment-1',
  })
})

const getSystemPromptVariantFidelityPlan = async (targetSystemPromptVariant: string | undefined) => {
  const fixturePayloads = getProjectTransferPayloadFixtureMap()
  const [fixtureJudgment] = fixturePayloads.judgments

  if (!fixtureJudgment) {
    throw new Error('Expected judgment fixture')
  }

  const importedJudgment = {...fixtureJudgment, systemPromptVariant: 'screening_v1'}
  const result = await getProjectTransferFidelityValidation({
    dependencyResolution: {
      modelTargetBySourceId: {'model-1': 'target-model-1'},
      providerTargetBySourceId: {'provider-connection-1': 'target-provider-1'},
    },
    payloads: {
      ...fixturePayloads,
      humanJudgmentSummaries: [],
      humanJudgments: [],
      judgmentAssessments: [],
      judgments: [importedJudgment],
      reviews: [],
    },
    runner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        const rows = statement.includes('FROM app.judgment')
          ? [
              {
                answeredOriginal: 'exclude',
                answeredOriginalAsArray: '["exclude"]',
                confidenceOriginal: 20,
                deleteGeneration: 0,
                explanation: 'Target judgment saved under another variant.',
                fullTextStrategyId: 'fts-none',
                isAnswered: true,
                quotes: '[]',
                ...(targetSystemPromptVariant === undefined ? {} : {systemPromptVariant: targetSystemPromptVariant}),
                targetArticleId: 'target-article-1',
                targetJudgmentId: 'target-judgment-1',
                targetModelId: 'target-model-1',
                targetPromptId: 'target-prompt-1',
                useAbstract: true,
                useFulltext: false,
                useFulltextNoImages: false,
                useMetadata: false,
                useTitle: true,
              },
            ]
          : []

        return rows as T[]
      },
    },
    targetPlan: getBaseTargetPlan(),
  })

  return {judgmentPlan: result.targetPlan.judgmentPlan[0], result}
}

test('judgment physical and review-visible keys include the system prompt variant', async () => {
  const legacyTarget = await getSystemPromptVariantFidelityPlan('legacy')
  const defaultTarget = await getSystemPromptVariantFidelityPlan(undefined)
  const sameVariantTarget = await getSystemPromptVariantFidelityPlan('screening_v1')

  expect(legacyTarget.judgmentPlan?.action).toBe('insert')
  expect(legacyTarget.judgmentPlan?.conflictCodes).toEqual([])
  expect(legacyTarget.judgmentPlan?.targetJudgmentId).toBe('new:judgment:judgment-1')
  expect(legacyTarget.judgmentPlan?.physicalKey).toBe(
    'target-article-1|target-prompt-1|target-model-1|true|true|false|false|false|screening_v1|fts-none|0',
  )
  expect(legacyTarget.judgmentPlan?.reviewVisibleKey).toBe(
    'target-article-1|target-prompt-1|target-model-1|true|true|false|false|false|screening_v1|fts-none',
  )
  expect(legacyTarget.result.conflictCounts.judgmentConflictCount).toBe(0)
  expect(defaultTarget.judgmentPlan?.action).toBe('insert')
  expect(defaultTarget.judgmentPlan?.conflictCodes).toEqual([])
  expect(sameVariantTarget.judgmentPlan?.targetJudgmentId).toBe('target-judgment-1')
  expect(sameVariantTarget.judgmentPlan?.conflictCodes).toContain('judgment_reused_benchmark_field_conflict')
})

test('judgments without a system prompt variant match legacy target judgments', async () => {
  const payloads = {
    ...getProjectTransferPayloadFixtureMap(),
    humanJudgmentSummaries: [],
    humanJudgments: [],
    judgmentAssessments: [],
    reviews: [],
  }
  const [importedJudgment] = payloads.judgments
  const statements: string[] = []

  if (!importedJudgment) {
    throw new Error('Expected judgment fixture')
  }

  const result = await getProjectTransferFidelityValidation({
    dependencyResolution: {
      modelTargetBySourceId: {'model-1': 'target-model-1'},
      providerTargetBySourceId: {'provider-connection-1': 'target-provider-1'},
    },
    payloads,
    runner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        statements.push(statement)
        const rows = statement.includes('FROM app.judgment')
          ? [
              {
                answeredOriginal: importedJudgment.answeredOriginal,
                answeredOriginalAsArray: JSON.stringify(importedJudgment.answeredOriginalAsArray ?? []),
                confidenceOriginal: importedJudgment.confidenceOriginal,
                deleteGeneration: 0,
                explanation: importedJudgment.explanation,
                fullTextStrategyId: 'fts-none',
                isAnswered: importedJudgment.isAnswered,
                quotes: JSON.stringify(importedJudgment.quotes ?? []),
                systemPromptVariant: 'legacy',
                targetArticleId: 'target-article-1',
                targetJudgmentId: 'target-judgment-1',
                targetModelId: 'target-model-1',
                targetPromptId: 'target-prompt-1',
                useAbstract: true,
                useFulltext: false,
                useFulltextNoImages: false,
                useMetadata: false,
                useTitle: true,
              },
            ]
          : []

        return rows as T[]
      },
    },
    targetPlan: getBaseTargetPlan(),
  })
  const [judgmentPlan] = result.targetPlan.judgmentPlan

  expect(Object.hasOwn(importedJudgment, 'systemPromptVariant')).toBe(false)
  expect(judgmentPlan?.action).toBe('reuse')
  expect(judgmentPlan?.targetJudgmentId).toBe('target-judgment-1')
  expect(judgmentPlan?.physicalKey).toBe(
    'target-article-1|target-prompt-1|target-model-1|true|true|false|false|false|legacy|fts-none|0',
  )
  expect(
    statements.some((statement) => {
      return (
        statement.includes('FROM app.judgment') && statement.includes('system_prompt_variant AS systemPromptVariant')
      )
    }),
  ).toBe(true)
})

const getUseMetadataFidelityPlan = async ({
  importedUseMetadata,
  targetUseMetadata,
}: {
  importedUseMetadata: boolean | undefined
  targetUseMetadata: boolean
}) => {
  const fixturePayloads = getProjectTransferPayloadFixtureMap()
  const [fixtureJudgment] = fixturePayloads.judgments
  const statements: string[] = []

  if (!fixtureJudgment) {
    throw new Error('Expected judgment fixture')
  }

  const fixtureContentSettings = fixtureJudgment.contentSettings as Record<string, unknown>
  const importedJudgment =
    importedUseMetadata === undefined
      ? fixtureJudgment
      : {...fixtureJudgment, contentSettings: {...fixtureContentSettings, useMetadata: importedUseMetadata}}
  const result = await getProjectTransferFidelityValidation({
    dependencyResolution: {
      modelTargetBySourceId: {'model-1': 'target-model-1'},
      providerTargetBySourceId: {'provider-connection-1': 'target-provider-1'},
    },
    payloads: {
      ...fixturePayloads,
      humanJudgmentSummaries: [],
      humanJudgments: [],
      judgmentAssessments: [],
      judgments: [importedJudgment],
      reviews: [],
    },
    runner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        statements.push(statement)
        const rows = statement.includes('FROM app.judgment')
          ? [
              {
                answeredOriginal: fixtureJudgment.answeredOriginal,
                answeredOriginalAsArray: JSON.stringify(fixtureJudgment.answeredOriginalAsArray ?? []),
                confidenceOriginal: fixtureJudgment.confidenceOriginal,
                deleteGeneration: 0,
                explanation: fixtureJudgment.explanation,
                fullTextStrategyId: 'fts-none',
                isAnswered: fixtureJudgment.isAnswered,
                quotes: JSON.stringify(fixtureJudgment.quotes ?? []),
                systemPromptVariant: 'legacy',
                targetArticleId: 'target-article-1',
                targetJudgmentId: 'target-judgment-1',
                targetModelId: 'target-model-1',
                targetPromptId: 'target-prompt-1',
                useAbstract: true,
                useFulltext: false,
                useFulltextNoImages: false,
                useMetadata: targetUseMetadata,
                useTitle: true,
              },
            ]
          : []

        return rows as T[]
      },
    },
    targetPlan: getBaseTargetPlan(),
  })

  return {fixtureContentSettings, judgmentPlan: result.targetPlan.judgmentPlan[0], statements}
}

test('judgment keys carry useMetadata and old judgments read it as false', async () => {
  const metadataOverPlainTarget = await getUseMetadataFidelityPlan({
    importedUseMetadata: true,
    targetUseMetadata: false,
  })
  const metadataOverMetadataTarget = await getUseMetadataFidelityPlan({
    importedUseMetadata: true,
    targetUseMetadata: true,
  })
  const oldOverMetadataTarget = await getUseMetadataFidelityPlan({
    importedUseMetadata: undefined,
    targetUseMetadata: true,
  })
  const oldOverPlainTarget = await getUseMetadataFidelityPlan({
    importedUseMetadata: undefined,
    targetUseMetadata: false,
  })
  const explicitFalseOverPlainTarget = await getUseMetadataFidelityPlan({
    importedUseMetadata: false,
    targetUseMetadata: false,
  })

  expect(Object.hasOwn(oldOverPlainTarget.fixtureContentSettings, 'useMetadata')).toBe(false)
  expect(metadataOverPlainTarget.judgmentPlan?.targetJudgmentId).toBeNull()
  expect(metadataOverPlainTarget.judgmentPlan?.conflictCodes).toEqual(['judgment_input_signature_mismatch'])
  expect(metadataOverPlainTarget.judgmentPlan?.physicalKey).toBe(
    'target-article-1|target-prompt-1|target-model-1|true|true|false|false|true|legacy|fts-none|0',
  )
  expect(metadataOverPlainTarget.judgmentPlan?.reviewVisibleKey).toBe(
    'target-article-1|target-prompt-1|target-model-1|true|true|false|false|true|legacy|fts-none',
  )
  expect(metadataOverMetadataTarget.judgmentPlan?.physicalKey).toBe(
    'target-article-1|target-prompt-1|target-model-1|true|true|false|false|true|legacy|fts-none|0',
  )
  expect(oldOverMetadataTarget.judgmentPlan?.action).toBe('insert')
  expect(oldOverMetadataTarget.judgmentPlan?.conflictCodes).toEqual([])
  expect(oldOverMetadataTarget.judgmentPlan?.physicalKey).toBe(
    'target-article-1|target-prompt-1|target-model-1|true|true|false|false|false|legacy|fts-none|0',
  )
  expect(oldOverPlainTarget.judgmentPlan?.action).toBe('reuse')
  expect(oldOverPlainTarget.judgmentPlan?.targetJudgmentId).toBe('target-judgment-1')
  expect(oldOverPlainTarget.judgmentPlan?.inputSignatureMatches).toBe(true)
  expect(oldOverPlainTarget.judgmentPlan?.conflictCodes).toEqual([])
  expect(explicitFalseOverPlainTarget.judgmentPlan).toEqual(oldOverPlainTarget.judgmentPlan)
  expect(
    oldOverPlainTarget.statements.some((statement) => {
      return (
        statement.includes('FROM app.judgment') && statement.includes('COALESCE(use_metadata, FALSE) AS useMetadata')
      )
    }),
  ).toBe(true)
})

test('judgment input signatures detect a useMetadata mismatch with the stored signature', async () => {
  const metadataOverMetadataTarget = await getUseMetadataFidelityPlan({
    importedUseMetadata: true,
    targetUseMetadata: true,
  })
  const explicitFalseOverPlainTarget = await getUseMetadataFidelityPlan({
    importedUseMetadata: false,
    targetUseMetadata: false,
  })

  expect(explicitFalseOverPlainTarget.judgmentPlan?.inputSignatureMatches).toBe(true)
  expect(metadataOverMetadataTarget.judgmentPlan?.inputSignatureMatches).toBe(false)
  expect(metadataOverMetadataTarget.judgmentPlan?.action).toBe('blocked')
  expect(metadataOverMetadataTarget.judgmentPlan?.targetJudgmentId).toBe('target-judgment-1')
  expect(metadataOverMetadataTarget.judgmentPlan?.conflictCodes).toEqual(['judgment_physical_key_not_equivalent'])
})

const fidelityFullTextStrategy = getFullTextStrategy({
  canonicalTextVersion: 'canonical-v1',
  chunkPolicy: {maxPromptTokens: 48_000, mode: 'chunked'},
  converterKind: 'mineru',
  converterOptionsHash: 'mineru-options-hash',
  converterVersion: '4.0.0',
  figureDescriptionModelId: null,
  figureDescriptionPromptVersion: null,
  figureMode: 'none',
  imageTransportVersion: null,
  promptLayoutVersion: 'layout-v1',
  tokenizerId: 'o200k_base',
})

const getFullTextStrategyFidelityPlan = async ({
  definedStrategies,
  importedStrategyId,
  signatureStrategyId,
  targetStrategyId,
}: {
  definedStrategies: unknown[]
  importedStrategyId: string | undefined
  signatureStrategyId: string | null
  targetStrategyId: string
}) => {
  const fixturePayloads = getProjectTransferPayloadFixtureMap()
  const [fixtureJudgment] = fixturePayloads.judgments

  if (!fixtureJudgment) {
    throw new Error('Expected judgment fixture')
  }

  const {fullTextStrategyId: _fixtureStrategyId, ...oldFixtureJudgment} = fixtureJudgment
  const contentSettings = {...(fixtureJudgment.contentSettings as Record<string, unknown>), useFulltext: true}
  const signature = fixtureJudgment.judgmentInputSignature as Record<string, Record<string, unknown>>
  const importedJudgment = {
    ...oldFixtureJudgment,
    contentSettings,
    judgmentInputSignature: {
      ...signature,
      contentSettings: {...signature.contentSettings, useFulltext: true},
      fullTextProcessing: {
        ...signature.fullTextProcessing,
        ...(signatureStrategyId === null ? {} : {fullTextStrategyId: signatureStrategyId}),
      },
    },
    ...(importedStrategyId === undefined ? {} : {fullTextStrategyId: importedStrategyId}),
  } as ProjectTransferPayloadRecord
  const result = await getProjectTransferFidelityValidation({
    dependencyResolution: {
      modelTargetBySourceId: {'model-1': 'target-model-1'},
      providerTargetBySourceId: {'provider-connection-1': 'target-provider-1'},
    },
    payloads: {
      ...fixturePayloads,
      humanJudgmentSummaries: [],
      humanJudgments: [],
      judgmentAssessments: [],
      judgments: [importedJudgment],
      project: {...fixturePayloads.project, fullTextStrategies: definedStrategies as FullTextStrategy[]},
      reviews: [],
    },
    runner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        const rows = statement.includes('FROM app.judgment')
          ? [
              {
                answeredOriginal: fixtureJudgment.answeredOriginal,
                answeredOriginalAsArray: JSON.stringify(fixtureJudgment.answeredOriginalAsArray ?? []),
                confidenceOriginal: fixtureJudgment.confidenceOriginal,
                deleteGeneration: 0,
                explanation: fixtureJudgment.explanation,
                fullTextStrategyId: targetStrategyId,
                isAnswered: fixtureJudgment.isAnswered,
                quotes: JSON.stringify(fixtureJudgment.quotes ?? []),
                systemPromptVariant: 'legacy',
                targetArticleId: 'target-article-1',
                targetJudgmentId: 'target-legacy-full-text-judgment',
                targetModelId: 'target-model-1',
                targetPromptId: 'target-prompt-1',
                useAbstract: true,
                useFulltext: true,
                useFulltextNoImages: false,
                useMetadata: false,
                useTitle: true,
              },
            ]
          : []

        return rows as T[]
      },
    },
    targetPlan: getBaseTargetPlan(),
  })

  return {blockers: result.blockers, judgmentPlan: result.targetPlan.judgmentPlan[0]}
}

test('judgment keys carry the full-text strategy so a new strategy never reuses a legacy full-text judgment', async () => {
  const strategyId = fidelityFullTextStrategy.id
  const strategyOverLegacyTarget = await getFullTextStrategyFidelityPlan({
    definedStrategies: [fidelityFullTextStrategy],
    importedStrategyId: strategyId,
    signatureStrategyId: strategyId,
    targetStrategyId: 'fts-legacy-v0',
  })
  const strategyOverStrategyTarget = await getFullTextStrategyFidelityPlan({
    definedStrategies: [fidelityFullTextStrategy],
    importedStrategyId: strategyId,
    signatureStrategyId: strategyId,
    targetStrategyId: strategyId,
  })
  const oldPackageOverLegacyTarget = await getFullTextStrategyFidelityPlan({
    definedStrategies: [],
    importedStrategyId: undefined,
    signatureStrategyId: null,
    targetStrategyId: 'fts-legacy-v0',
  })

  expect(strategyOverLegacyTarget.judgmentPlan).toMatchObject({
    action: 'insert',
    conflictCodes: [],
    inputSignatureMatches: true,
    physicalKey: `target-article-1|target-prompt-1|target-model-1|true|true|true|false|false|legacy|${strategyId}|0`,
    reviewVisibleKey: `target-article-1|target-prompt-1|target-model-1|true|true|true|false|false|legacy|${strategyId}`,
    targetJudgmentId: 'new:judgment:judgment-1',
  })
  expect(strategyOverStrategyTarget.judgmentPlan).toMatchObject({
    action: 'reuse',
    conflictCodes: [],
    targetJudgmentId: 'target-legacy-full-text-judgment',
  })
  expect(oldPackageOverLegacyTarget.judgmentPlan).toMatchObject({
    action: 'reuse',
    conflictCodes: [],
    inputSignatureMatches: true,
    physicalKey: 'target-article-1|target-prompt-1|target-model-1|true|true|true|false|false|legacy|fts-legacy-v0|0',
    targetJudgmentId: 'target-legacy-full-text-judgment',
  })
})

test('judgments with an undefined or unsigned full-text strategy are blocked', async () => {
  const strategyId = fidelityFullTextStrategy.id
  const undefinedStrategy = await getFullTextStrategyFidelityPlan({
    definedStrategies: [],
    importedStrategyId: strategyId,
    signatureStrategyId: strategyId,
    targetStrategyId: 'fts-legacy-v0',
  })
  const unsignedStrategy = await getFullTextStrategyFidelityPlan({
    definedStrategies: [fidelityFullTextStrategy],
    importedStrategyId: strategyId,
    signatureStrategyId: null,
    targetStrategyId: 'fts-legacy-v0',
  })

  expect(undefinedStrategy.judgmentPlan?.action).toBe('blocked')
  expect(undefinedStrategy.judgmentPlan?.conflictCodes).toEqual(['judgment_full_text_strategy_undefined'])
  expect(
    undefinedStrategy.blockers.filter((blocker) => {
      return blocker.code === 'judgment_full_text_strategy_undefined'
    }),
  ).toEqual([
    {
      code: 'judgment_full_text_strategy_undefined',
      message: 'judgment-1 uses a full-text strategy that the package does not define',
      resolutionKind: 'requires_new_package_or_target_changes',
      scope: 'judgments.judgment-1',
    },
  ])
  expect(unsignedStrategy.judgmentPlan?.action).toBe('blocked')
  expect(unsignedStrategy.judgmentPlan?.inputSignatureMatches).toBe(false)
  expect(unsignedStrategy.judgmentPlan?.conflictCodes).toEqual(['judgment_input_signature_mismatch'])
})
