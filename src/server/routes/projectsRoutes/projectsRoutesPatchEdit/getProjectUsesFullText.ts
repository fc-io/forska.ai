import {FULL_TEXT_STRATEGY_LEGACY} from '../../../fullText/fullTextStrategy.ts'
import type {ProjectEditCurrentProject} from './projectEditTypes.ts'

export const getProjectUsesFullText = (
  project: Pick<ProjectEditCurrentProject, 'fullTextStrategyId' | 'useFulltext'>,
) => {
  return project.useFulltext || project.fullTextStrategyId === FULL_TEXT_STRATEGY_LEGACY
}
