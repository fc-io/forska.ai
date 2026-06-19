import {afterEach, expect, mock, test} from 'bun:test'

const appDatabaseServiceModulePath = new URL('../../services/appDatabaseService.ts', import.meta.url).pathname
const appQueryServiceModulePath = new URL('../../services/getAppQueryService.ts', import.meta.url).pathname
const reviewServingManifestRepositoryModulePath = new URL(
  '../../reviewServing/reviewServingManifestRepository.ts',
  import.meta.url,
).pathname
const reviewServingReaderModulePath = new URL('../../reviewServing/reviewServingReader.ts', import.meta.url).pathname
const reviewServingProjectConfigIdentityModulePath = new URL(
  '../../services/reviewServingProjectConfigIdentity.ts',
  import.meta.url,
).pathname

const projectReviewConfigRef = {
  current: async (_projectId: string): Promise<unknown> => {
    return {importRouteIds: []}
  },
}

const queryJsonRef = {
  current: async (_statement: string): Promise<unknown[]> => {
    return []
  },
}

const runRef = {current: async (_statement: string): Promise<void> => {}}

const readReviewServingRowsRef = {
  current: async (_request: unknown): Promise<unknown> => {
    return {rows: [{article_id: 'article-1'}], status: 'ready'}
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

const transactionRef = {
  current: async <T>(
    operation: (tx: {queryJson: typeof queryJsonRef.current; run: typeof runRef.current}) => Promise<T>,
  ) => {
    return operation({queryJson: queryJsonRef.current, run: runRef.current})
  },
}

const registerModuleMocks = () => {
  void mock.module(appQueryServiceModulePath, () => {
    return {
      getAppQueryService: () => {
        return {
          getProjectReviewConfig: (projectId: string) => {
            return projectReviewConfigRef.current(projectId)
          },
        }
      },
    }
  })

  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: (statement: string) => {
            return queryJsonRef.current(statement)
          },
          run: (statement: string) => {
            return runRef.current(statement)
          },
          transaction: (operation: Parameters<typeof transactionRef.current>[0]) => {
            return transactionRef.current(operation)
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
}

const loadHandler = async (): Promise<typeof import('./humanAssessmentRoutesPostInit.ts')> => {
  registerModuleMocks()

  return import(`./humanAssessmentRoutesPostInit.ts?test=${Date.now()}-${Math.random()}`) as Promise<
    typeof import('./humanAssessmentRoutesPostInit.ts')
  >
}

afterEach(() => {
  readReviewServingRowsRef.current = async () => {
    return {rows: [{article_id: 'article-1'}], status: 'ready'}
  }
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

test('human assessment init inserts project id before the answered flag', async () => {
  const statements: string[] = []
  const readerRequests: unknown[] = []
  projectReviewConfigRef.current = async () => {
    return {importRouteIds: []}
  }
  queryJsonRef.current = async (statement) => {
    statements.push(statement)

    return statement.includes("WHERE id = 'project-1'")
      ? [{id: 'project-1', name: 'Project 1'}]
      : statement.includes('FROM app.project_prompt pp')
        ? [{id: 'prompt-1', originalText: 'Prompt 1', promptHeading: 'Heading 1', order: 0, type: 'string'}]
        : statement.includes('ORDER BY created_at DESC')
          ? []
          : statement.includes('FROM app.article')
            ? [{articleSummary: 'Summary 1', articleTitle: 'Article 1', id: 'article-1'}]
            : statement.includes('FROM app.project_article')
              ? [{articleId: 'article-1'}]
              : statement.includes('INSERT INTO app.judgment_human')
                ? [{id: 'judgment-human-1', promptId: 'prompt-1'}]
                : []
  }
  runRef.current = async (statement) => {
    statements.push(statement)
  }
  readReviewServingRowsRef.current = async (request) => {
    readerRequests.push(request)
    return {rows: [{article_id: 'article-1'}], status: 'ready'}
  }
  transactionRef.current = async (operation) => {
    return operation({queryJson: queryJsonRef.current, run: runRef.current})
  }

  const {humanAssessmentRoutesPostInit} = await loadHandler()
  const set: {status: number} = {status: 200}
  const response = await humanAssessmentRoutesPostInit({body: {projectId: 'project-1'}, set: set as never})
  const insertStatement =
    statements.find((statement) => {
      return statement.includes('INSERT INTO app.judgment_human')
    }) ?? ''

  expect(insertStatement).toContain('(id, article_id, prompt_id, project_id, is_answered, answer, comment)')
  expect(insertStatement).toMatch(/\('[^']+', 'article-1', 'prompt-1', 'project-1', FALSE, NULL, NULL\)/)
  expect(statements.join('\n')).not.toContain('ORDER BY RANDOM()')
  expect(readerRequests).toEqual([
    expect.objectContaining({
      contractKey: 'review.queue.unassessed',
      filters: {queueKind: 'human-unreviewed'},
      projectId: 'project-1',
      queueKind: 'human-unreviewed',
      searchMode: 'none',
      snapshotId: 'snapshot-1',
    }),
  ])
  expect(response).toEqual({
    data: {
      article: {articleSummary: 'Summary 1', articleTitle: 'Article 1', id: 'article-1'},
      judgmentsHuman: [{id: 'judgment-human-1', promptId: 'prompt-1'}],
      project: {id: 'project-1', name: 'Project 1'},
      prompts: [{id: 'prompt-1', order: 0, originalText: 'Prompt 1', promptHeading: 'Heading 1', type: 'string'}],
    },
  })
})

test('human assessment init rejects summary-mode projects before creating pending rows', async () => {
  const statements: string[] = []
  projectReviewConfigRef.current = async () => {
    return {importRouteIds: []}
  }
  queryJsonRef.current = async (statement) => {
    statements.push(statement)

    return statement.includes("WHERE id = 'project-1'")
      ? [{humanJudgmentMode: 'summary', id: 'project-1', name: 'Project 1'}]
      : statement.includes('FROM app.project_prompt pp')
        ? [{id: 'prompt-1', originalText: 'Prompt 1', promptHeading: 'Heading 1', order: 0, type: 'string'}]
        : statement.includes('FROM app.judgment_human_summary') && statement.includes('ORDER BY created_at DESC')
          ? []
          : statement.includes('FROM app.article a')
            ? [{articleSummary: 'Summary 1', articleTitle: 'Article 1', id: 'article-1'}]
            : statement.includes('FROM app.project_article')
              ? [{articleId: 'article-1'}]
              : statement.includes('INSERT INTO app.judgment_human_summary')
                ? [{id: 'judgment-summary-1', promptId: 'summary'}]
                : []
  }
  runRef.current = async (statement) => {
    statements.push(statement)
  }
  transactionRef.current = async (operation) => {
    return operation({queryJson: queryJsonRef.current, run: runRef.current})
  }

  const {humanAssessmentRoutesPostInit} = await loadHandler()
  const set: {status: number} = {status: 200}
  const response = await humanAssessmentRoutesPostInit({body: {projectId: 'project-1'}, set: set as never})

  expect(set.status).toBe(409)
  expect(response).toEqual({data: null, error: 'Summary-mode projects do not support prompt-based human assessment'})
  expect(
    statements.some((statement) => {
      return statement.includes('INSERT INTO app.judgment_human_summary')
    }),
  ).toBe(false)
})

test('human assessment init falls back to scoped articles when serving human queue is empty', async () => {
  const statements: string[] = []
  queryJsonRef.current = async (statement) => {
    statements.push(statement)

    return statement.includes("WHERE id = 'project-1'")
      ? [{humanJudgmentMode: 'prompt', id: 'project-1', name: 'Project 1'}]
      : statement.includes('FROM app.project_prompt pp')
        ? [{id: 'prompt-1', originalText: 'Prompt 1', promptHeading: 'Heading 1', order: 0, type: 'string'}]
        : statement.includes('ORDER BY created_at DESC')
          ? []
          : statement.includes('FROM mart.project_scope_article')
            ? [{articleId: 'article-2'}]
            : statement.includes('FROM app.article')
              ? [{articleSummary: 'Summary 2', articleTitle: 'Article 2', id: 'article-2'}]
              : statement.includes('INSERT INTO app.judgment_human')
                ? [{id: 'judgment-human-2', promptId: 'prompt-1'}]
                : []
  }
  readReviewServingRowsRef.current = async () => {
    return {rows: [], status: 'accepted'}
  }

  const {humanAssessmentRoutesPostInit} = await loadHandler()
  const set: {status: number} = {status: 200}
  const response = await humanAssessmentRoutesPostInit({body: {projectId: 'project-1'}, set: set as never})

  expect(set.status).toBe(200)
  expect(response.data?.article.id).toBe('article-2')
  expect(statements.join('\n')).toContain('FROM mart.project_scope_article')
})
