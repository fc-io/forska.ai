import {reprojectReviewServingHumanStatus} from '../../reviewServing/reviewServingHumanStatusReprojectService.ts'

export const projectsRoutesPostReprojectHumanStatus = async ({params}: {params: {id: string}}) => {
  return {data: await reprojectReviewServingHumanStatus({projectId: params.id})}
}
