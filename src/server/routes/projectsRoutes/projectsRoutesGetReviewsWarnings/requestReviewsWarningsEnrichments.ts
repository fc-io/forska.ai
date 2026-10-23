import {
  detailReadyReviewServingComponents,
  filterReadyReviewServingComponents,
  type ReviewServingProjectionComponent,
} from '../../../reviewServing/reviewServingContracts.ts'
import {requestReviewServingV4Rebuild} from '../../../reviewServing/reviewServingV4RebuildRequestService.ts'
import {getReviewsWarningsCoverage} from './getReviewsWarningsCoverage.ts'

const filterEnrichmentReviewServingRepairPriority = 500
const detailEnrichmentReviewServingRepairPriority = 500
const searchEnrichmentReviewServingRepairPriority = 500
const warningFilterEnrichmentReviewServingComponents = [
  ...filterReadyReviewServingComponents,
  'queue',
] as const satisfies readonly ReviewServingProjectionComponent[]
const warningDetailEnrichmentReviewServingComponents = [
  'posting',
  'summary',
  ...detailReadyReviewServingComponents,
] as const satisfies readonly ReviewServingProjectionComponent[]

export const requestReviewsWarningsEnrichments = async ({
  coverage,
  hasReadableReviewServingRows,
  isServerMutationWorkDisabled,
  projectId,
  reviewServingProjectorPaused,
}: {
  coverage: Awaited<ReturnType<typeof getReviewsWarningsCoverage>>
  hasReadableReviewServingRows: boolean
  isServerMutationWorkDisabled: boolean
  projectId: string
  reviewServingProjectorPaused: boolean
}) => {
  const shouldRequestFilterEnrichment =
    !isServerMutationWorkDisabled
    && !reviewServingProjectorPaused
    && hasReadableReviewServingRows
    && coverage.filterReadyArticleCount === null

  if (shouldRequestFilterEnrichment) {
    await requestReviewServingV4Rebuild({
      components: warningFilterEnrichmentReviewServingComponents,
      priority: filterEnrichmentReviewServingRepairPriority,
      projectId,
      reason: 'filterReadinessEnrichment',
    }).catch(() => {
      return undefined
    })
  }

  const shouldRequestDetailEnrichment =
    !isServerMutationWorkDisabled
    && !reviewServingProjectorPaused
    && hasReadableReviewServingRows
    && coverage.filterReadyArticleCount !== null
    && coverage.detailReadyArticleCount === null

  if (shouldRequestDetailEnrichment) {
    await requestReviewServingV4Rebuild({
      components: warningDetailEnrichmentReviewServingComponents,
      priority: detailEnrichmentReviewServingRepairPriority,
      projectId,
      reason: 'detailReadinessDirtyWork',
    }).catch(() => {
      return undefined
    })
  }

  // A served snapshot without search (one built before search was carried forward, or a search build that was given
  // up) only regains it from search dirty work, which a quiet project never produces. Ask for it here like the other
  // enrichments; the planner adds it to the active snapshot in place.
  const shouldRequestSearchEnrichment =
    !isServerMutationWorkDisabled
    && !reviewServingProjectorPaused
    && hasReadableReviewServingRows
    && coverage.filterReadyArticleCount !== null
    && coverage.detailReadyArticleCount !== null
    && coverage.searchReadyArticleCount === null

  if (shouldRequestSearchEnrichment) {
    await requestReviewServingV4Rebuild({
      components: ['search'],
      priority: searchEnrichmentReviewServingRepairPriority,
      projectId,
      reason: 'searchReadinessDirtyWork',
    }).catch(() => {
      return undefined
    })
  }
}
