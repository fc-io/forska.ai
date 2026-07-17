import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingProjectScopePatches,
  type ReviewServingProjectScopeProjectorDatabase,
} from './reviewServingProjectScopeProjector.ts'

const projectScopeClaim = (): ReviewServingDirtyWorkClaim => {
  return {
    articleId: 'article-1',
    dirtyKind: 'projectScope.article.added',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: 'dirty-work-1',
    firstSourceHighWaterMark: 12,
    latestDeltaId: 'delta-1',
    latestSourceHighWaterMark: 14,
    projectId: 'project-1',
    projectionComponent: 'projectScope',
    projectionIdentity: 'projectScope:identity-1',
    scopeId: 'project-1:article-1',
    scopeKind: 'article',
    sourcePartition: 'projectScope:project-1',
    status: 'running',
  }
}

test('project scope projector writes manifest and acknowledges scoped article work', async () => {
  const statements: string[] = []
  const database: ReviewServingProjectScopeProjectorDatabase = {
    queryJson: async <T>(_statement: string) => {
      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }

  const result = await projectReviewServingProjectScopePatches(
    {
      baseGeneration: 5,
      claims: [projectScopeClaim()],
      definitionVersion: 'project-scope-v4-test',
      projectId: 'project-1',
      projectionIdentity: 'projectScope:identity-1',
    },
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({patchWatermark: 14})
  expect(joined).toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).toContain("'projectScope'")
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(joined).toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).toContain('WHERE NOT EXISTS')
})

test('project scope no-ack snapshot passes do not publish shared manifests or watermarks', async () => {
  const statements: string[] = []
  const database: ReviewServingProjectScopeProjectorDatabase = {
    queryJson: async <T>(_statement: string) => {
      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }

  await projectReviewServingProjectScopePatches(
    {
      acknowledgeClaims: false,
      baseGeneration: 5,
      claims: [projectScopeClaim()],
      definitionVersion: 'project-scope-v4-test',
      projectId: 'project-1',
      projectionIdentity: 'projectScope:identity-1',
    },
    database,
  )
  const joined = statements.join('\n')

  expect(joined).not.toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).not.toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).not.toContain('INSERT INTO app.review_serving_dirty_work_ack')
})
