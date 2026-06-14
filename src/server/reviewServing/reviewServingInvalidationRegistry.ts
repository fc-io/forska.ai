import {
  isReviewServingChangeKind,
  type ReviewServingChangeKind,
  reviewServingChangeKinds,
  type ReviewServingProjectionComponent,
} from './reviewServingContracts.ts'

export type ReviewServingDeltaUpdateMode =
  | 'appendPatch'
  | 'componentPatch'
  | 'componentRebuild'
  | 'contributionDiff'
  | 'promptScopedRebuild'

export type ReviewServingInvalidationRule = {
  affectedComponents: readonly ReviewServingProjectionComponent[]
  changeKind: ReviewServingChangeKind
  downstreamDependents: readonly ReviewServingProjectionComponent[]
  firstAffectedComponent: ReviewServingProjectionComponent
  requiredKeys: readonly string[]
  updateMode: ReviewServingDeltaUpdateMode
}

const rule = (input: ReviewServingInvalidationRule) => {
  return input
}

export const reviewServingInvalidationRegistry: Record<ReviewServingChangeKind, ReviewServingInvalidationRule> = {
  'article.display.updated': rule({
    affectedComponents: ['display', 'payload', 'posting', 'summary'],
    changeKind: 'article.display.updated',
    downstreamDependents: ['payload', 'posting', 'summary'],
    firstAffectedComponent: 'display',
    requiredKeys: ['articleId', 'changedDisplayFieldNames', 'sourceHighWaterMark'],
    updateMode: 'componentPatch',
  }),
  'article.judgmentInput.updated': rule({
    affectedComponents: ['judgmentInputContent', 'llmStatus', 'queue', 'posting', 'summary', 'payload'],
    changeKind: 'article.judgmentInput.updated',
    downstreamDependents: ['llmStatus', 'queue', 'posting', 'summary', 'payload'],
    firstAffectedComponent: 'judgmentInputContent',
    requiredKeys: ['articleId', 'affectedContentFlags', 'sourceHighWaterMark'],
    updateMode: 'componentPatch',
  }),
  'article.searchText.updated': rule({
    affectedComponents: ['search'],
    changeKind: 'article.searchText.updated',
    downstreamDependents: [],
    firstAffectedComponent: 'search',
    requiredKeys: ['articleId', 'changedSearchableFieldNames', 'sourceHighWaterMark'],
    updateMode: 'componentPatch',
  }),
  'importRoute.article.added': rule({
    affectedComponents: ['projectScope', 'selectedImport', 'posting', 'summary'],
    changeKind: 'importRoute.article.added',
    downstreamDependents: ['selectedImport', 'posting', 'summary'],
    firstAffectedComponent: 'projectScope',
    requiredKeys: ['importRouteId', 'articleId', 'importSourceRecordKey', 'sourceHighWaterMark'],
    updateMode: 'appendPatch',
  }),
  'importRoute.article.rankFields.updated': rule({
    affectedComponents: ['selectedImport', 'posting', 'summary'],
    changeKind: 'importRoute.article.rankFields.updated',
    downstreamDependents: ['posting', 'summary'],
    firstAffectedComponent: 'selectedImport',
    requiredKeys: ['importRouteId', 'articleId', 'changedRankFilterFields', 'sourceHighWaterMark'],
    updateMode: 'componentPatch',
  }),
  'importRoute.article.removed': rule({
    affectedComponents: ['projectScope', 'selectedImport', 'posting', 'summary'],
    changeKind: 'importRoute.article.removed',
    downstreamDependents: ['selectedImport', 'posting', 'summary'],
    firstAffectedComponent: 'projectScope',
    requiredKeys: ['importRouteId', 'articleId', 'importSourceRecordKey', 'sourceHighWaterMark'],
    updateMode: 'appendPatch',
  }),
  'judgment.human.updated': rule({
    affectedComponents: ['humanStatus', 'posting', 'summary'],
    changeKind: 'judgment.human.updated',
    downstreamDependents: ['posting', 'summary'],
    firstAffectedComponent: 'humanStatus',
    requiredKeys: ['projectId', 'articleId', 'promptId', 'humanJudgmentKey', 'sourceHighWaterMark'],
    updateMode: 'contributionDiff',
  }),
  'judgment.llm.created': rule({
    affectedComponents: ['llmStatus', 'queue', 'posting', 'summary'],
    changeKind: 'judgment.llm.created',
    downstreamDependents: ['queue', 'posting', 'summary'],
    firstAffectedComponent: 'llmStatus',
    requiredKeys: [
      'projectId',
      'articleId',
      'promptId',
      'modelId',
      'contentFlags',
      'judgmentId',
      'sourceHighWaterMark',
    ],
    updateMode: 'contributionDiff',
  }),
  'judgment.llm.deleted': rule({
    affectedComponents: ['llmStatus', 'queue', 'posting', 'summary'],
    changeKind: 'judgment.llm.deleted',
    downstreamDependents: ['queue', 'posting', 'summary'],
    firstAffectedComponent: 'llmStatus',
    requiredKeys: [
      'projectId',
      'articleId',
      'promptId',
      'modelId',
      'contentFlags',
      'judgmentId',
      'sourceHighWaterMark',
    ],
    updateMode: 'contributionDiff',
  }),
  'judgment.llm.updated': rule({
    affectedComponents: ['llmStatus', 'queue', 'posting', 'summary'],
    changeKind: 'judgment.llm.updated',
    downstreamDependents: ['queue', 'posting', 'summary'],
    firstAffectedComponent: 'llmStatus',
    requiredKeys: [
      'projectId',
      'articleId',
      'promptId',
      'modelId',
      'contentFlags',
      'judgmentId',
      'sourceHighWaterMark',
    ],
    updateMode: 'contributionDiff',
  }),
  'project.reviewConfig.updated': rule({
    affectedComponents: ['judgmentInputContent', 'llmStatus', 'humanStatus', 'queue', 'posting', 'summary'],
    changeKind: 'project.reviewConfig.updated',
    downstreamDependents: ['llmStatus', 'humanStatus', 'queue', 'posting', 'summary'],
    firstAffectedComponent: 'judgmentInputContent',
    requiredKeys: ['projectId', 'changedReviewConfigFields', 'sourceHighWaterMark'],
    updateMode: 'componentRebuild',
  }),
  'projectScope.article.added': rule({
    affectedComponents: [
      'projectScope',
      'selectedImport',
      'llmStatus',
      'humanStatus',
      'queue',
      'posting',
      'summary',
      'payload',
    ],
    changeKind: 'projectScope.article.added',
    downstreamDependents: ['selectedImport', 'llmStatus', 'humanStatus', 'queue', 'posting', 'summary', 'payload'],
    firstAffectedComponent: 'projectScope',
    requiredKeys: ['projectId', 'articleId', 'routeImportSourceKey', 'sourceHighWaterMark'],
    updateMode: 'appendPatch',
  }),
  'projectScope.article.removed': rule({
    affectedComponents: [
      'projectScope',
      'selectedImport',
      'llmStatus',
      'humanStatus',
      'queue',
      'posting',
      'summary',
      'payload',
    ],
    changeKind: 'projectScope.article.removed',
    downstreamDependents: ['selectedImport', 'llmStatus', 'humanStatus', 'queue', 'posting', 'summary', 'payload'],
    firstAffectedComponent: 'projectScope',
    requiredKeys: ['projectId', 'articleId', 'routeImportSourceKey', 'sourceHighWaterMark'],
    updateMode: 'appendPatch',
  }),
  'prompt.config.updated': rule({
    affectedComponents: ['llmStatus', 'humanStatus', 'queue', 'posting', 'summary'],
    changeKind: 'prompt.config.updated',
    downstreamDependents: ['queue', 'posting', 'summary'],
    firstAffectedComponent: 'llmStatus',
    requiredKeys: ['projectId', 'promptId', 'changedPromptConfigFields', 'sourceHighWaterMark'],
    updateMode: 'promptScopedRebuild',
  }),
}

export const getReviewServingInvalidationRule = (changeKind: ReviewServingChangeKind) => {
  return reviewServingInvalidationRegistry[changeKind]
}

export const getReviewServingInvalidationRuleOrNull = (changeKind: string) => {
  return isReviewServingChangeKind(changeKind) ? reviewServingInvalidationRegistry[changeKind] : null
}

export const getUnmappedReviewServingChangeKinds = () => {
  return reviewServingChangeKinds.filter((changeKind) => {
    return reviewServingInvalidationRegistry[changeKind] === undefined
  })
}
