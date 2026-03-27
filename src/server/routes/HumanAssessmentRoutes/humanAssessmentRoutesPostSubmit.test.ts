import {expect, mock, test} from 'bun:test'

const appDatabaseServiceModulePath = new URL('../../services/appDatabaseService.ts', import.meta.url).pathname
const martRefreshServiceModulePath = new URL('../../services/getDuckdbMartRefreshService.ts', import.meta.url).pathname

const queryJsonRef = {
  current: async (_statement: string): Promise<unknown[]> => {
    return []
  },
}

const runRef = {current: async (_statement: string): Promise<void> => {}}

const queuedArticleRefreshesRef = {current: [] as Array<{articleId: string; reason: string}>}

const queuedProjectRefreshesRef = {current: [] as Array<{projectId: string; reason: string}>}

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
      }
    },
  }
})

void mock.module(martRefreshServiceModulePath, () => {
  return {
    getDuckdbMartRefreshService: () => {
      return {
        queueJudgmentArticleRefresh: async (articleId: string, reason: string) => {
          queuedArticleRefreshesRef.current.push({articleId, reason})
        },
        queueProjectRefresh: async (projectId: string, reason: string) => {
          queuedProjectRefreshesRef.current.push({projectId, reason})
        },
      }
    },
  }
})

test('human assessment submit queues an article refresh for the pending article', async () => {
  const statements: string[] = []
  queuedArticleRefreshesRef.current = []
  queuedProjectRefreshesRef.current = []
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

  const {humanAssessmentRoutesPostSubmit} = await import('./humanAssessmentRoutesPostSubmit.ts')
  const set = {status: 200} as Parameters<typeof humanAssessmentRoutesPostSubmit>[0]['set']
  const response = await humanAssessmentRoutesPostSubmit({
    body: {
      answers: [{answer: 'yes', comment: 'looks good', judgmentHumanId: 'judgment-human-1'}],
      projectId: 'project-1',
    },
    set,
  })

  expect(response).toEqual({data: {updated: 1}})
  expect(queuedArticleRefreshesRef.current).toEqual([
    {articleId: 'article-1', reason: 'humanAssessmentRoutesPostSubmit'},
  ])
  expect(queuedProjectRefreshesRef.current).toEqual([])
  expect(
    statements.some((statement) => {
      return statement.includes('UPDATE app.judgment_human') && statement.includes('is_answered = TRUE')
    }),
  ).toBe(true)
})
