import {expect, test} from 'bun:test'

import type {ProjectTransferTargetPlan} from './projectTransferAnalyzeTarget.ts'
import {getProjectTransferFidelityValidation} from './projectTransferFidelityValidation.ts'
import {getProjectTransferPayloadFixtureMap} from './projectTransferPayloadSchemas.ts'

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
                isAnswered: true,
                quotes: [{quote: 'Fixture quote'}],
                targetArticleId: 'target-article-1',
                targetJudgmentId: 'target-title-only-judgment',
                targetModelId: 'target-model-1',
                targetPromptId: 'target-prompt-1',
                useAbstract: false,
                useFulltext: false,
                useFulltextNoImages: false,
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
  expect(judgmentPlan?.reviewVisibleKey).toBe('target-article-1:target-prompt-1:target-model-1:true:true:false:false')
  expect(result.conflictCounts.judgmentConflictCount).toBe(0)
})
