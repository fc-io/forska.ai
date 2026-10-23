import {
  detailReadyReviewServingComponents,
  type ReviewServingProjectionComponent,
} from '../../../reviewServing/reviewServingContracts.ts'
import {requestReviewServingV4Rebuild} from '../../../reviewServing/reviewServingV4RebuildRequestService.ts'

const detailReadinessReviewServingRepairPriority = 1_000
const articleDetailRepairReviewServingComponents = [
  'posting',
  'summary',
  ...detailReadyReviewServingComponents,
] as const satisfies readonly ReviewServingProjectionComponent[]

export const requestReviewDetailReadinessRepair = async (projectId: string): Promise<boolean> => {
  const request = await requestReviewServingV4Rebuild({
    components: articleDetailRepairReviewServingComponents,
    priority: detailReadinessReviewServingRepairPriority,
    projectId,
    reason: 'detailReadinessDirtyWork',
  }).catch(() => {
    return null
  })

  return request?.status === 'pending_admission' || request?.status === 'admitted' || request?.status === 'running'
}
