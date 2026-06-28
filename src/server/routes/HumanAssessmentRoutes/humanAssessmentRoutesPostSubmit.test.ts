import {afterEach, expect, mock, test} from 'bun:test'

const appDatabaseServiceModulePath = new URL('../../services/appDatabaseService.ts', import.meta.url).pathname
const comparisonProjectServingInvalidationServiceModulePath = new URL(
  '../../services/comparisonProjectServingInvalidationService.ts',
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

const comparisonServingInvalidationMarksRef = {
  current: [] as Array<{changes: Array<{articleId: string; promptId: string}>; hasRunner: boolean}>,
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

  void mock.module(comparisonProjectServingInvalidationServiceModulePath, () => {
    return {
      getComparisonProjectServingInvalidationService: () => {
        return {
          markComparisonProjectsServingStaleForHumanPromptJudgments: async (
            changes: Array<{articleId: string; promptId: string}>,
            options?: {runner?: unknown},
          ) => {
            comparisonServingInvalidationMarksRef.current.push({changes, hasRunner: options?.runner != null})
          },
        }
      },
    }
  })
}

const loadHandler = async (): Promise<typeof import('./humanAssessmentRoutesPostSubmit.ts')> => {
  registerModuleMocks()

  return import(`./humanAssessmentRoutesPostSubmit.ts?test=${Date.now()}-${Math.random()}`) as Promise<
    typeof import('./humanAssessmentRoutesPostSubmit.ts')
  >
}

afterEach(() => {
  mock.restore()
})

test('human assessment submit appends V4 deltas without legacy dirty ledger writes', async () => {
  const statements: string[] = []
  comparisonServingInvalidationMarksRef.current = []
  queryJsonRef.current = async (statement) => {
    statements.push(statement)

    return statement.includes('SELECT DISTINCT article_id AS articleId')
      ? [{articleId: 'article-1'}]
      : statement.includes('FROM app.project_prompt pp')
        ? [{id: 'prompt-1'}]
        : statement.includes('FROM app.review_delta_reconciliation_cursor')
          ? [{sourceHighWaterMark: 1}]
          : statement.includes('SELECT id, prompt_id AS promptId, is_answered AS isAnswered')
            ? [{id: 'judgment-human-1', promptId: 'prompt-1', isAnswered: false}]
            : statement.includes('FROM app.judgment_human jh')
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
  const set: {status: number} = {status: 200}
  const response = await humanAssessmentRoutesPostSubmit({
    body: {
      answers: [{answer: 'yes', comment: 'looks good', judgmentHumanId: 'judgment-human-1'}],
      projectId: 'project-1',
    },
    set: set as never,
  })

  expect(response).toEqual({data: {updated: 1}})
  expect(comparisonServingInvalidationMarksRef.current).toEqual([
    {changes: [{articleId: 'article-1', promptId: 'prompt-1'}], hasRunner: true},
  ])
  expect(
    statements.some((statement) => {
      return statement.includes('UPDATE app.judgment_human') && statement.includes('is_answered = TRUE')
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return statement.includes('INSERT INTO app.review_change_delta') && statement.includes('judgment.human.updated')
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return statement.includes('INSERT INTO app.review_write_overlay') && statement.includes('humanJudgment.answer')
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return statement.includes('app.review_serving_snapshot_manifest') || statement.includes('mart.review_')
    }),
  ).toBe(false)
  expect(
    statements.some((statement) => {
      return statement.includes('SELECT DISTINCT article_id AS articleId') && statement.includes('LIMIT 2')
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return statement.includes('FROM app.judgment_human jh') && statement.includes("AND jh.article_id = 'article-1'")
    }),
  ).toBe(true)
})

test('human assessment submit rejects summary-mode projects before prompt validation', async () => {
  const statements: string[] = []
  comparisonServingInvalidationMarksRef.current = []
  queryJsonRef.current = async (statement) => {
    statements.push(statement)

    return statement.includes('FROM app.project') ? [{humanJudgmentMode: 'summary'}] : []
  }
  runRef.current = async (statement) => {
    statements.push(statement)
  }
  transactionRef.current = async (operation) => {
    return operation({queryJson: queryJsonRef.current, run: runRef.current})
  }

  const {humanAssessmentRoutesPostSubmit} = await loadHandler()
  const set: {status: number} = {status: 200}
  const response = await humanAssessmentRoutesPostSubmit({
    body: {answers: [{answer: 'yes', judgmentHumanId: 'judgment-summary-1'}], projectId: 'project-1'},
    set: set as never,
  })

  expect(set.status).toBe(409)
  expect(response).toEqual({data: null, error: 'Summary-mode projects do not support prompt-based human assessment'})
  expect(comparisonServingInvalidationMarksRef.current).toEqual([])
  expect(
    statements.some((statement) => {
      return (
        statement.includes('FROM app.judgment_human_summary') || statement.includes('UPDATE app.judgment_human_summary')
      )
    }),
  ).toBe(false)
})

test('human assessment submit skips deltas for blank optional answers', async () => {
  const statements: string[] = []
  comparisonServingInvalidationMarksRef.current = []
  queryJsonRef.current = async (statement) => {
    statements.push(statement)

    return statement.includes('SELECT DISTINCT article_id AS articleId')
      ? [{articleId: 'article-optional'}]
      : statement.includes('FROM app.project_prompt pp')
        ? [{id: 'prompt-optional'}]
        : statement.includes('FROM app.review_delta_reconciliation_cursor')
          ? [{sourceHighWaterMark: 1}]
          : statement.includes('SELECT id, prompt_id AS promptId, is_answered AS isAnswered')
            ? [{id: 'judgment-human-optional', promptId: 'prompt-optional', isAnswered: false}]
            : statement.includes('FROM app.judgment_human jh')
              ? [
                  {
                    articleId: 'article-optional',
                    id: 'judgment-human-optional',
                    promptId: 'prompt-optional',
                    type: 'string | null',
                  },
                ]
              : statement.includes('WHERE id IN') && statement.includes('AND is_answered = FALSE')
                ? [{id: 'judgment-human-optional'}]
                : []
  }
  runRef.current = async (statement) => {
    statements.push(statement)
  }
  transactionRef.current = async (operation) => {
    return operation({queryJson: queryJsonRef.current, run: runRef.current})
  }

  const {humanAssessmentRoutesPostSubmit} = await loadHandler()
  const set: {status: number} = {status: 200}
  const response = await humanAssessmentRoutesPostSubmit({
    body: {answers: [{answer: '   ', judgmentHumanId: 'judgment-human-optional'}], projectId: 'project-optional'},
    set: set as never,
  })

  expect(response).toEqual({data: {updated: 1}})
  expect(
    statements.some((statement) => {
      return statement.includes('INSERT INTO app.review_change_delta') && statement.includes('judgment.human.updated')
    }),
  ).toBe(false)
  expect(comparisonServingInvalidationMarksRef.current).toEqual([
    {changes: [{articleId: 'article-optional', promptId: 'prompt-optional'}], hasRunner: true},
  ])
})
