export const projectTransferRouteSpecs = [
  {
    endpoint: 'get-export-project-summary',
    method: 'GET',
    path: '/api/projects/:id/export-project',
    samplePath: '/api/projects/project-1/export-project',
  },
  {
    endpoint: 'export-project',
    method: 'POST',
    path: '/api/projects/:id/export-project',
    samplePath: '/api/projects/project-1/export-project',
  },
  {
    endpoint: 'get-export',
    method: 'GET',
    path: '/api/projects/export/:exportId',
    samplePath: '/api/projects/export/export-1',
  },
  {
    endpoint: 'download-export',
    method: 'GET',
    path: '/api/projects/export/:exportId/download',
    samplePath: '/api/projects/export/export-1/download',
  },
  {
    endpoint: 'create-import-session',
    method: 'POST',
    path: '/api/projects/import/sessions',
    samplePath: '/api/projects/import/sessions',
  },
  {
    endpoint: 'upload-import-package',
    method: 'PUT',
    path: '/api/projects/import/:sessionId/upload',
    samplePath: '/api/projects/import/session-1/upload',
  },
  {
    endpoint: 'analyze-import-session',
    method: 'POST',
    path: '/api/projects/import/:sessionId/analyze',
    samplePath: '/api/projects/import/session-1/analyze',
  },
  {
    endpoint: 'get-import-session',
    method: 'GET',
    path: '/api/projects/import/:sessionId',
    samplePath: '/api/projects/import/session-1',
  },
  {
    endpoint: 'resolve-import-dependencies',
    method: 'POST',
    path: '/api/projects/import/:sessionId/resolve-dependencies',
    samplePath: '/api/projects/import/session-1/resolve-dependencies',
  },
  {
    endpoint: 'commit-import-session',
    method: 'POST',
    path: '/api/projects/import/:sessionId/commit',
    samplePath: '/api/projects/import/session-1/commit',
  },
  {
    endpoint: 'delete-import-session',
    method: 'DELETE',
    path: '/api/projects/import/:sessionId',
    samplePath: '/api/projects/import/session-1',
  },
] as const
