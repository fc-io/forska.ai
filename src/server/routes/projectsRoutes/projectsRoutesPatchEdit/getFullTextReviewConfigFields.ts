import type {ProjectReviewConfigReviewServingField} from '../../../reviewServing/reviewConfigReviewServingDeltaService.ts'
import {getProjectFullTextValues, type ProjectFullTextResolution} from '../projectFullTextSettings.ts'
import type {ProjectEditCurrentProject} from './projectEditTypes.ts'

export const getFullTextReviewConfigFields = (params: {
  currentProject: ProjectEditCurrentProject
  fullTextResolution: ProjectFullTextResolution | null
  useFulltext: boolean
}): ProjectReviewConfigReviewServingField[] => {
  const currentFullText = getProjectFullTextValues(params.currentProject)
  const fields: Array<ProjectReviewConfigReviewServingField | null> = params.fullTextResolution
    ? [
        params.useFulltext !== params.currentProject.useFulltext ? 'useFulltext' : null,
        params.currentProject.useFulltextNoImages ? 'useFulltextNoImages' : null,
        params.fullTextResolution.fullTextStrategyId !== currentFullText.fullTextStrategyId
          ? 'fullTextStrategyId'
          : null,
      ]
    : []

  return fields.filter((field): field is ProjectReviewConfigReviewServingField => {
    return field !== null
  })
}
