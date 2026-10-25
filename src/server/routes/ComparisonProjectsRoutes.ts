import {Elysia} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {comparisonProjectsRoutesDeleteArchive} from './comparisonProjectsRoutes/comparisonProjectsRoutesDeleteArchive.ts'
import {comparisonProjectsRoutesDeletePurge} from './comparisonProjectsRoutes/comparisonProjectsRoutesDeletePurge.ts'
import {comparisonProjectsRoutesGetArchived} from './comparisonProjectsRoutes/comparisonProjectsRoutesGetArchived.ts'
import {comparisonProjectsRoutesGetConflictResolutionImportSources} from './comparisonProjectsRoutes/comparisonProjectsRoutesGetConflictResolutionImportSources.ts'
import {comparisonProjectsRoutesGetDetail} from './comparisonProjectsRoutes/comparisonProjectsRoutesGetDetail.ts'
import {comparisonProjectsRoutesGetEdit} from './comparisonProjectsRoutes/comparisonProjectsRoutesGetEdit.ts'
import {comparisonProjectsRoutesGetList} from './comparisonProjectsRoutes/comparisonProjectsRoutesGetList.ts'
import {comparisonProjectsRoutesGetSources} from './comparisonProjectsRoutes/comparisonProjectsRoutesGetSources.ts'
import {comparisonProjectsRoutesGetStats} from './comparisonProjectsRoutes/comparisonProjectsRoutesGetStats.ts'
import {comparisonProjectsRoutesPatchUpdate} from './comparisonProjectsRoutes/comparisonProjectsRoutesPatchUpdate.ts'
import {comparisonProjectsRoutesPostConflictComment} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostConflictComment.ts'
import {comparisonProjectsRoutesPostConflictResolution} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostConflictResolution.ts'
import {comparisonProjectsRoutesPostConflictResolutionImportPreview} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostConflictResolutionImportPreview.ts'
import {comparisonProjectsRoutesPostConflictResolutionReset} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostConflictResolutionReset.ts'
import {comparisonProjectsRoutesPostConflictResolutionsExport} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostConflictResolutionsExport.ts'
import {comparisonProjectsRoutesPostConflictResolutionsImportAnalyze} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostConflictResolutionsImportAnalyze.ts'
import {comparisonProjectsRoutesPostConflictResolutionsImportCommit} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostConflictResolutionsImportCommit.ts'
import {comparisonProjectsRoutesPostConflictResolutionsImportPdfAnalyze} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostConflictResolutionsImportPdfAnalyze.ts'
import {comparisonProjectsRoutesPostConflictResolutionsImportPdfCommit} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostConflictResolutionsImportPdfCommit.ts'
import {comparisonProjectsRoutesPostCovidenceExport} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostCovidenceExport.ts'
import {comparisonProjectsRoutesPostCovidenceExportCount} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostCovidenceExportCount.ts'
import {comparisonProjectsRoutesPostCreate} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostCreate.ts'
import {comparisonProjectsRoutesPostExport} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostExport.ts'
import {comparisonProjectsRoutesPostFromProject} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostFromProject.ts'
import {comparisonProjectsRoutesPostJudgmentContexts} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostJudgmentContexts.ts'
import {comparisonProjectsRoutesPostJudgments} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostJudgments.ts'
import {comparisonProjectsRoutesPostJudgmentsCount} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostJudgmentsCount.ts'
import {comparisonProjectsRoutesPostUnarchive} from './comparisonProjectsRoutes/comparisonProjectsRoutesPostUnarchive.ts'

export const comparisonProjectsRoutes = new Elysia()
  .use(withErrorHandler())
  .use([
    comparisonProjectsRoutesGetList,
    comparisonProjectsRoutesGetArchived,
    comparisonProjectsRoutesGetSources,
    comparisonProjectsRoutesPostJudgmentContexts,
    comparisonProjectsRoutesGetConflictResolutionImportSources,
    comparisonProjectsRoutesPostConflictResolutionImportPreview,
    comparisonProjectsRoutesPostFromProject,
    comparisonProjectsRoutesGetEdit,
    comparisonProjectsRoutesGetStats,
    comparisonProjectsRoutesGetDetail,
    comparisonProjectsRoutesPostJudgments,
    comparisonProjectsRoutesPostJudgmentsCount,
    comparisonProjectsRoutesPostConflictResolution,
    comparisonProjectsRoutesPostConflictComment,
    comparisonProjectsRoutesPostConflictResolutionReset,
    comparisonProjectsRoutesPostConflictResolutionsExport,
    comparisonProjectsRoutesPostConflictResolutionsImportAnalyze,
    comparisonProjectsRoutesPostConflictResolutionsImportPdfAnalyze,
    comparisonProjectsRoutesPostConflictResolutionsImportCommit,
    comparisonProjectsRoutesPostConflictResolutionsImportPdfCommit,
    comparisonProjectsRoutesPostExport,
    comparisonProjectsRoutesPostCovidenceExportCount,
    comparisonProjectsRoutesPostCovidenceExport,
    comparisonProjectsRoutesPostCreate,
    comparisonProjectsRoutesPatchUpdate,
    comparisonProjectsRoutesDeletePurge,
    comparisonProjectsRoutesDeleteArchive,
    comparisonProjectsRoutesPostUnarchive,
  ])
