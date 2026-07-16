import {readFileSync} from 'node:fs'

import {afterEach, expect, mock, test} from 'bun:test'

const appDatabaseServiceModulePath = new URL('../../services/appDatabaseService.ts', import.meta.url).pathname
const reviewServingManifestRepositoryModulePath = new URL(
  '../../reviewServing/reviewServingManifestRepository.ts',
  import.meta.url,
).pathname
const reviewServingReaderModulePath = new URL('../../reviewServing/reviewServingReader.ts', import.meta.url).pathname
const reviewServingProjectConfigIdentityModulePath = new URL(
  '../../services/reviewServingProjectConfigIdentity.ts',
  import.meta.url,
).pathname
const systemActorModulePath = new URL('../../utils/getSystemActor.ts', import.meta.url).pathname

const queryJsonRef = {
  current: async (_statement: string): Promise<unknown[]> => {
    return []
  },
}

const readReviewServingRowsRef = {
  current: async (_request: unknown): Promise<unknown> => {
    return {rows: [], status: 'accepted'}
  },
}

const activeManifestRef = {
  current: async (_params: unknown): Promise<unknown> => {
    return {reviewConfigHash: 'review-config-1', snapshotId: 'snapshot-1'}
  },
}

const lastKnownManifestRef = {
  current: async (_params: unknown): Promise<unknown> => {
    return null
  },
}

const currentReviewConfigHashRef = {
  current: async (_projectId: string): Promise<string | null> => {
    return 'review-config-1'
  },
}

const registerModuleMocks = () => {
  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: (statement: string) => {
            return queryJsonRef.current(statement)
          },
        }
      },
    }
  })

  void mock.module(reviewServingManifestRepositoryModulePath, () => {
    return {
      getActiveReviewServingSnapshotManifest: (params: unknown) => {
        return activeManifestRef.current(params)
      },
      getLastKnownGoodReviewServingSnapshotManifest: (params: unknown) => {
        return lastKnownManifestRef.current(params)
      },
    }
  })

  void mock.module(reviewServingReaderModulePath, () => {
    return {
      readReviewServingRows: (request: unknown) => {
        return readReviewServingRowsRef.current(request)
      },
    }
  })

  void mock.module(reviewServingProjectConfigIdentityModulePath, () => {
    return {
      getCurrentReviewConfigHash: (projectId: string) => {
        return currentReviewConfigHashRef.current(projectId)
      },
    }
  })

  void mock.module(systemActorModulePath, () => {
    return {
      getSystemActor: () => {
        return {
          email: 'local-uv2Idd2BF6VNSNjwY5IKmIeoYMKq6zXw@forska.local',
          id: 'uv2Idd2BF6VNSNjwY5IKmIeoYMKq6zXw',
          name: 'Local User',
        }
      },
    }
  })
}

const loadOverviewHandlers = async () => {
  registerModuleMocks()

  const cacheKey = `${Date.now()}-${Math.random()}`
  const overview = (await import(
    `./humanAssessmentRoutesGetOverview.ts?test=${cacheKey}`
  )) as typeof import('./humanAssessmentRoutesGetOverview.ts')
  const overviewBoth = (await import(
    `./humanAssessmentRoutesGetOverviewBothProjects.ts?test=${cacheKey}`
  )) as typeof import('./humanAssessmentRoutesGetOverviewBothProjects.ts')

  return {overview, overviewBoth}
}

afterEach(() => {
  activeManifestRef.current = async () => {
    return {reviewConfigHash: 'review-config-1', snapshotId: 'snapshot-1'}
  }
  lastKnownManifestRef.current = async () => {
    return null
  }
  currentReviewConfigHashRef.current = async () => {
    return 'review-config-1'
  }
  mock.restore()
})

test('human assessment overview reads V4 human count contracts instead of raw judgment aggregates', async () => {
  const statements: string[] = []
  const readerRequests: unknown[] = []
  queryJsonRef.current = async (statement) => {
    statements.push(statement)

    return statement.includes('FROM app.project')
      ? [
          {id: 'project-low', name: 'Project Low'},
          {id: 'project-high', name: 'Project High'},
        ]
      : []
  }
  readReviewServingRowsRef.current = async (request) => {
    readerRequests.push(request)
    const projectId = (request as {projectId?: string}).projectId

    return {rows: [{availability: 'ready', count_value: projectId === 'project-high' ? 3 : 1}], status: 'accepted'}
  }

  const {overview} = await loadOverviewHandlers()
  const response = await overview.humanAssessmentRoutesGetOverview({
    request: new Request('http://test'),
    set: {} as never,
  })

  expect(response.data.projects).toEqual([
    {count: 3, projectId: 'project-high', projectName: 'Project High'},
    {count: 1, projectId: 'project-low', projectName: 'Project Low'},
  ])
  expect(response.data.users).toEqual([
    {
      count: 4,
      email: 'local-uv2Idd2BF6VNSNjwY5IKmIeoYMKq6zXw@forska.local',
      userId: 'uv2Idd2BF6VNSNjwY5IKmIeoYMKq6zXw',
      userName: 'Local User',
    },
  ])
  expect(readerRequests).toEqual([
    expect.objectContaining({
      contractKey: 'review.human.count',
      countFilterKey: 'list:all',
      namedCountKey: 'review.list.total',
    }),
    expect.objectContaining({
      contractKey: 'review.human.count',
      countFilterKey: 'list:all',
      namedCountKey: 'review.list.total',
    }),
  ])
  expect(statements.join('\n')).not.toContain('FROM app.judgment_human')
  expect(statements.join('\n')).not.toContain('FROM app.project_prompt')
  expect(statements.join('\n')).not.toContain('OFFSET')
})

test('human assessment overview active project read is not capped after materialization', () => {
  const routeText = readFileSync('src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesGetOverview.ts', 'utf8')
  const projectRead = routeText.slice(
    routeText.indexOf('const projects = await getAppDatabaseService().queryJson'),
    routeText.indexOf('const projectsWithCounts = await Promise.all'),
  )

  expect(projectRead).toContain('ORDER BY created_at DESC, id ASC')
  expect(projectRead).toContain("getHumanAssessmentWorkloadContext({operation: 'overview.activeProjects'})")
  expect(projectRead).not.toContain('maxResultRows')
  expect(projectRead).not.toContain('LIMIT')
})

test('human assessment both-project overview reads V4 both count contracts', async () => {
  const statements: string[] = []
  const readerRequests: unknown[] = []
  queryJsonRef.current = async (statement) => {
    statements.push(statement)

    return statement.includes('FROM app.project') ? [{id: 'project-both', name: 'Project Both'}] : []
  }
  readReviewServingRowsRef.current = async (request) => {
    readerRequests.push(request)

    return {rows: [{availability: 'ready', count_value: 2}], status: 'accepted'}
  }

  const {overviewBoth} = await loadOverviewHandlers()
  const response = await overviewBoth.humanAssessmentRoutesGetOverviewBothProjects({
    request: new Request('http://test'),
    set: {} as never,
  })

  expect(response).toEqual({data: [{count: 2, projectId: 'project-both', projectName: 'Project Both'}]})
  expect(readerRequests).toEqual([
    expect.objectContaining({
      contractKey: 'review.both.count',
      countFilterKey: 'list:all',
      namedCountKey: 'review.list.total',
    }),
  ])
  expect(statements.join('\n')).not.toContain('FROM app.judgment_human')
  expect(statements.join('\n')).not.toContain('FROM app.judgment')
  expect(statements.join('\n')).not.toContain('FROM app.project_prompt')
})
