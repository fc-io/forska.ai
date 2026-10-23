import {Elysia} from 'elysia'

import {rejectLegacyFullTextNoImagesBody} from '../utils/rejectLegacyFullTextNoImagesBody.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {subprojectsRoutesGetSources} from './subprojectsRoutes/subprojectsRoutesGetSources.ts'
import {subprojectsRoutesPostCreate} from './subprojectsRoutes/subprojectsRoutesPostCreate.ts'
import {subprojectsRoutesPostCreateBody} from './subprojectsRoutes/subprojectsRoutesPostCreateBody.ts'

export const subprojectsRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/subprojects/sources', subprojectsRoutesGetSources)
  .post('/api/subprojects', subprojectsRoutesPostCreate, {
    transform: rejectLegacyFullTextNoImagesBody,
    body: subprojectsRoutesPostCreateBody,
  })
