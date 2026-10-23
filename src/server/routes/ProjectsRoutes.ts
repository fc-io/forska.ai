import {Elysia} from 'elysia'

import {rejectLegacyFullTextNoImagesBody} from '../utils/rejectLegacyFullTextNoImagesBody.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {projectsRoutesDeleteProject} from './projectsRoutes/projectsRoutesDeleteProject.ts'
import {projectsRoutesGetAccess} from './projectsRoutes/projectsRoutesGetAccess.ts'
import {projectsRoutesGetArchived} from './projectsRoutes/projectsRoutesGetArchived.ts'
import {projectsRoutesGetArticlesReviews} from './projectsRoutes/projectsRoutesGetArticlesReviews.ts'
import {projectsRoutesGetArticlesReviewsBoth} from './projectsRoutes/projectsRoutesGetArticlesReviewsBoth.ts'
import {projectsRoutesGetArticlesReviewsCount} from './projectsRoutes/projectsRoutesGetArticlesReviewsCount.ts'
import {projectsRoutesGetArticlesReviewsFilters} from './projectsRoutes/projectsRoutesGetArticlesReviewsFilters.ts'
import {projectsRoutesGetArticlesReviewsHuman} from './projectsRoutes/projectsRoutesGetArticlesReviewsHuman.ts'
import {projectsRoutesGetArticlesReviewsHumanFilters} from './projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.ts'
import {projectsRoutesGetArticlesReviewsUnassessed} from './projectsRoutes/projectsRoutesGetArticlesReviewsUnassessed.ts'
import {projectsRoutesGetProject} from './projectsRoutes/projectsRoutesGetProject.ts'
import {projectsRoutesGetProjectQuery} from './projectsRoutes/projectsRoutesGetProjectQuery.ts'
import {projectsRoutesGetProjects} from './projectsRoutes/projectsRoutesGetProjects.ts'
import {projectsRoutesGetProjectsWithoutJobs} from './projectsRoutes/projectsRoutesGetProjectsWithoutJobs.ts'
import {projectsRoutesGetPromptPreview} from './projectsRoutes/projectsRoutesGetPromptPreview.ts'
import {projectsRoutesGetReviewsWarnings} from './projectsRoutes/projectsRoutesGetReviewsWarnings.ts'
import {projectsRoutesPatchEdit} from './projectsRoutes/projectsRoutesPatchEdit.ts'
import {projectsRoutesPatchEditBody} from './projectsRoutes/projectsRoutesPatchEditBody.ts'
import {projectsRoutesPatchProject} from './projectsRoutes/projectsRoutesPatchProject.ts'
import {projectsRoutesPatchProjectBody} from './projectsRoutes/projectsRoutesPatchProjectBody.ts'
import {projectsRoutesPostArticleReviewDetails} from './projectsRoutes/projectsRoutesPostArticleReviewDetails.ts'
import {projectsRoutesPostClone} from './projectsRoutes/projectsRoutesPostClone.ts'
import {projectsRoutesPostCreate} from './projectsRoutes/projectsRoutesPostCreate.ts'
import {projectsRoutesPostCreateBody} from './projectsRoutes/projectsRoutesPostCreateBody.ts'
import {projectsRoutesPostDeleteArchived} from './projectsRoutes/projectsRoutesPostDeleteArchived.ts'
import {projectsRoutesPostFullTextValidation} from './projectsRoutes/projectsRoutesPostFullTextValidation.ts'
import {projectsRoutesPostUnarchive} from './projectsRoutes/projectsRoutesPostUnarchive.ts'
import {rejectProjectPatchSettingsBody} from './projectsRoutes/rejectProjectPatchSettingsBody.ts'

export const projectsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(projectsRoutesGetArticlesReviews)
  .use(projectsRoutesGetArticlesReviewsCount)
  .use(projectsRoutesGetArticlesReviewsBoth)
  .use(projectsRoutesGetArticlesReviewsHuman)
  .use(projectsRoutesGetArticlesReviewsUnassessed)
  .use(projectsRoutesGetArticlesReviewsFilters)
  .use(projectsRoutesGetArticlesReviewsHumanFilters)
  .use(projectsRoutesGetPromptPreview)
  .use(projectsRoutesPostFullTextValidation)
  .use(projectsRoutesPostArticleReviewDetails)
  .use(projectsRoutesPostDeleteArchived)
  .use(projectsRoutesGetReviewsWarnings)
  .use(projectsRoutesGetProjectsWithoutJobs)
  .get('/api/projects', projectsRoutesGetProjects)
  .get('/api/projects/archived', projectsRoutesGetArchived)
  .get('/api/projects/:id/access', projectsRoutesGetAccess)
  .get('/api/projects/:id', projectsRoutesGetProject, {query: projectsRoutesGetProjectQuery})
  .post('/api/projects', projectsRoutesPostCreate, {
    transform: rejectLegacyFullTextNoImagesBody,
    body: projectsRoutesPostCreateBody,
  })
  .patch('/api/projects/:id', projectsRoutesPatchProject, {
    body: projectsRoutesPatchProjectBody,
    transform: rejectProjectPatchSettingsBody,
  })
  .patch('/api/projects/:id/edit', projectsRoutesPatchEdit, {
    transform: rejectLegacyFullTextNoImagesBody,
    body: projectsRoutesPatchEditBody,
  })
  .delete('/api/projects/:id', projectsRoutesDeleteProject)
  .post('/api/projects/:id/unarchive', projectsRoutesPostUnarchive)
  .post('/api/projects/:id/clone', projectsRoutesPostClone)
