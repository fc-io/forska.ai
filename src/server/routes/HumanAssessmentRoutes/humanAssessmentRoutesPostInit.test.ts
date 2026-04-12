import {afterEach, expect, mock, test} from 'bun:test'

const appDatabaseServiceModulePath = new URL('../../services/appDatabaseService.ts', import.meta.url).pathname
const appQueryServiceModulePath = new URL('../../services/getAppQueryService.ts', import.meta.url).pathname

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
        }
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
  mock.restore()
})

test('human assessment init inserts project id before the answered flag', async () => {
  const statements: string[] = []
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
          : statement.includes('FROM app.article a')
            ? [{articleSummary: 'Summary 1', articleTitle: 'Article 1', id: 'article-1'}]
            : statement.includes('FROM app.project_article')
              ? [{articleId: 'article-1'}]
              : statement.includes('INSERT INTO app.judgment_human')
                ? [{id: 'judgment-human-1', promptId: 'prompt-1'}]
                : []
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
