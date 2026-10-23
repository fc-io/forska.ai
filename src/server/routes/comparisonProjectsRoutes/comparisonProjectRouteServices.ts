import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getComparisonProjectServingGenerationService} from '../../services/comparisonProjectServingGenerationService.ts'
import {getComparisonProjectServingRebuildService} from '../../services/comparisonProjectServingRebuildService.ts'

export const appDatabaseService = getAppDatabaseService()
export const comparisonProjectServingGenerationService = getComparisonProjectServingGenerationService()
export const comparisonProjectServingRebuildService = getComparisonProjectServingRebuildService()
