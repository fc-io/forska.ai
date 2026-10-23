import type {RouteSurfaceRoute} from './routeSurfaceInventoryTypes.ts'
import {ownerDependentMaintenance, ownerDependentProduct, ownerDependentSensitive} from './routeSurfaceRouteGroups.ts'

export const articlesRouteSurfaceRoutes: RouteSurfaceRoute[] = [
  ...ownerDependentProduct('ArticlesRoutes.ts', [
    ['GET', '/api/articles/latest'],
    ['GET', '/api/articles/search'],
    ['GET', '/api/articles/pdf-fetch-jobs/:jobId'],
  ]),
  ...ownerDependentSensitive(
    'ArticlesRoutes.ts',
    'Article records, PDFs, external fetches, and destructive article operations.',
    [
      ['GET', '/api/articles/conversion-stats'],
      ['POST', '/api/articles/conversion-reset'],
      ['POST', '/api/articles/pdf-fetch-bulk'],
      ['POST', '/api/articles/pdf-fetch-by-filter'],
      ['POST', '/api/articles/pdf-fetch-by-project'],
      ['POST', '/api/articles/batch-upsert'],
      ['GET', '/api/articles/:id'],
      ['DELETE', '/api/articles/:id'],
    ],
  ),
  ...ownerDependentMaintenance('ArticlesRoutes.ts', 'PDF fetch reset control.', [
    ['POST', '/api/articles/pdf-fetch-reset'],
  ]),
  ...ownerDependentSensitive(
    'ArticleAdminRoutes.ts',
    'Local PDFs, uploaded files, fetched full text, and conversion state.',
    [
      ['GET', '/api/articles/:id/admin-info'],
      ['POST', '/api/articles/:id/fetch-pdf'],
      ['POST', '/api/articles/:id/upload-pdf'],
      ['POST', '/api/articles/:id/convert-pdf'],
      ['POST', '/api/articles/conversion-reconvert'],
      ['POST', '/api/articles/:id/canonical-fulltext/rebuild'],
    ],
  ),
]
