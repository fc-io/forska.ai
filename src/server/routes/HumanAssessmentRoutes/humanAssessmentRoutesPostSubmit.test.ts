import {afterEach, expect, mock, test} from 'bun:test'

const appDatabaseServiceModulePath = new URL('../../services/appDatabaseService.ts', import.meta.url).pathname
const projectMartRefreshStateServiceModulePath = new URL(
  '../../services/projectMartRefreshStateService.ts',
  import.meta.url,
).pathname

const queryJsonRef = {
  current: async (_statement: string): Promise<unknown[]> => {
    return []
  },
}

const runRef = {current: async (_statement: string): Promise<void> => {}}

const transactionRef = {
  current: async <T>(
    operation: (tx: {queryJson: typeof queryJsonRef.current; run: typeof runRef.current}) => Promise<T>,
  ) => {
    return operation({queryJson: queryJsonRef.current, run: runRef.current})
  },
}

const dirtyMarksRef = {
  current: [] as Array<{
    hasRunner: boolean
    projects: Array<{articleIds?: string[]; projectId: string}>
    reason: string | null | undefined
  }>,
}

const registerModuleMocks = () => {
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

  void mock.module(projectMartRefreshStateServiceModulePath, () => {
    return {
      getProjectMartRefreshStateService: () => {
        return {
          markProjectsDirtyAtomically: async (params: {
            projects: Array<{articleIds?: string[]; projectId: string}>
            reason?: string | null
            runner?: unknown
          }) => {
            dirtyMarksRef.current.push({
              hasRunner: params.runner != null,
              projects: params.projects,
              reason: params.reason,
            })
          },
        }
      },
    }
  })
}

const loadHandler = () => {
  registerModuleMocks()

  return import(`./humanAssessmentRoutesPostSubmit.ts?test=${Date.now()}-${Math.random()}`)
}

afterEach(() => {
  mock.restore()
})

test('human assessment submit marks the project dirty in the same transaction for the pending article', async () => {
  const statements: string[] = []
  dirtyMarksRef.current = []
  queryJsonRef.current = async (statement) => {
    statements.push(statement)

    return statement.includes('FROM app.judgment_human jh')
      ? [{id: 'judgment-human-1', promptId: 'prompt-1', articleId: 'article-1', type: 'string'}]
      : statement.includes('WHERE id IN') && statement.includes('AND is_answered = FALSE')
        ? [{id: 'judgment-human-1'}]
        : []
  }
  runRef.current = async (statement) => {
    statements.push(statement)
  }
  transactionRef.current = async (operation) => {
    return operation({queryJson: queryJsonRef.current, run: runRef.current})
  }

  const {humanAssessmentRoutesPostSubmit} = await loadHandler()
  const set = {status: 200} as Parameters<typeof humanAssessmentRoutesPostSubmit>[0]['set']
  const response = await humanAssessmentRoutesPostSubmit({
    body: {
      answers: [{answer: 'yes', comment: 'looks good', judgmentHumanId: 'judgment-human-1'}],
      projectId: 'project-1',
    },
    set,
  })

  expect(response).toEqual({data: {updated: 1}})
  expect(dirtyMarksRef.current).toEqual([
    {
      hasRunner: true,
      projects: [{articleIds: ['article-1'], projectId: 'project-1'}],
      reason: 'humanAssessmentRoutesPostSubmit',
    },
  ])
  expect(
    statements.some((statement) => {
      return statement.includes('UPDATE app.judgment_human') && statement.includes('is_answered = TRUE')
    }),
  ).toBe(true)
})
