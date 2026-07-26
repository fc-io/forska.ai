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
      getActiveOrLastKnownGoodReviewServingSnapshotManifest: async (params: unknown) => {
        return (await activeManifestRef.current(params)) ?? (await lastKnownManifestRef.current(params))
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

    if (statement.includes('FROM app.project')) {
      return [
        {id: 'project-low', name: 'Project Low'},
        {id: 'project-high', name: 'Project High'},
      ]
    }

    if (statement.includes('mart.review_article_serving_base_v4 serving')) {
      return [
        {projectId: 'project-low', totalCount: 1},
        {projectId: 'project-high', totalCount: 3},
      ]
    }

    return []
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
  expect(readerRequests).toEqual([])
  const joinedStatements = statements.join('\n')
  expect(joinedStatements).toContain('WITH overview_manifest(project_id, review_config_hash, snapshot_id) AS')
  expect(joinedStatements).toContain("'project-low'")
  expect(joinedStatements).toContain("'project-high'")
  expect(joinedStatements).toContain('COUNT(DISTINCT list_mode_state.article_id) AS totalCount')
  expect(joinedStatements).toContain("list_contains(list_mode_state.list_mode_keys, 'human')")
  expect(joinedStatements).toContain("list_mode_state.human_status = 'answered'")
  expect(joinedStatements).toContain('LEFT JOIN mart.review_article_serving_base_v4 serving')
  expect(joinedStatements).toContain('LEFT JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(joinedStatements).not.toContain('mart.review_article_serving_v4 serving')
  expect(joinedStatements).not.toContain('review_article_filter_state_serving_v4')
  expect(joinedStatements).not.toContain('serving.human_status_key =')
  expect(joinedStatements).not.toContain('serving.llm_status_key =')
  expect(statements.join('\n')).not.toContain('FROM app.judgment_human')
  expect(statements.join('\n')).not.toContain('FROM app.project_prompt')
  expect(statements.join('\n')).not.toContain('OFFSET')
})

test('human assessment overview active project read is not capped after materialization', () => {
  const routeText = readFileSync('src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesGetOverview.ts', 'utf8')
  const projectRead = routeText.slice(
    routeText.indexOf('const projects = await database.queryJson'),
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

    if (statement.includes('FROM app.project')) {
      return [{id: 'project-both', name: 'Project Both'}]
    }

    if (statement.includes('mart.review_article_serving_base_v4 serving')) {
      return [{projectId: 'project-both', totalCount: 2}]
    }

    return []
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
  expect(readerRequests).toEqual([])
  const joinedStatements = statements.join('\n')
  expect(joinedStatements).toContain("list_contains(list_mode_state.list_mode_keys, 'both')")
  expect(joinedStatements).toContain("list_mode_state.human_status = 'answered'")
  expect(joinedStatements).toContain("list_mode_state.llm_status = 'answered'")
  expect(joinedStatements).toContain('LEFT JOIN mart.review_article_serving_base_v4 serving')
  expect(joinedStatements).toContain('LEFT JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(joinedStatements).not.toContain('mart.review_article_serving_v4 serving')
  expect(joinedStatements).not.toContain('review_article_filter_state_serving_v4')
  expect(joinedStatements).not.toContain('serving.human_status_key =')
  expect(joinedStatements).not.toContain('serving.llm_status_key =')
  expect(joinedStatements).not.toContain('FROM app.judgment_human')
  expect(joinedStatements).not.toContain('FROM app.judgment')
  expect(joinedStatements).not.toContain('FROM app.project_prompt')
})
