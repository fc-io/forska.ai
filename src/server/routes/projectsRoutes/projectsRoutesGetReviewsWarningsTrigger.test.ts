import {expect, test} from 'bun:test'

const getLastJsonLine = (stdout: string) => {
  const lines = stdout
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line !== ''
    })

  return lines.at(-1) ?? ''
}

test('reviews warnings trigger mart refresh draining when backlog exists on a writer', () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')
        const {Elysia} = await import('elysia')

        const routeModulePath = new URL('./src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts', 'file://' + process.cwd() + '/').pathname
        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const martRefreshServiceModulePath = new URL('./src/server/services/getDuckdbMartRefreshService.ts', 'file://' + process.cwd() + '/').pathname
        const projectAccessGuardModulePath = new URL('./src/server/routes/projectsRoutes/projectAccessGuard.ts', 'file://' + process.cwd() + '/').pathname
        const serverRuntimeRoleModulePath = new URL('./src/server/utils/serverRuntimeRole.ts', 'file://' + process.cwd() + '/').pathname
        let flushCount = 0

        const getMockQueryRows = (statement) => {
          return statement.includes('FROM app.project_prompt')
            ? [{count: 1}]
            : statement.includes('FROM app.project_article') && statement.includes('LIMIT 1')
              ? [{articleId: 'article-trigger-test'}]
              : statement.includes('FROM app.project_import_route') && statement.includes('LIMIT 1')
                ? []
                : statement.includes('MIN(created_at) AS oldestQueuedAt')
                  ? [{oldestQueuedAt: '2026-03-25T12:00:00.000Z', queuedRefreshCount: 1}]
                  : statement.includes('MIN(queue.created_at) AS oldestQueuedAt')
                    ? [{oldestQueuedAt: null, queuedRefreshCount: 0}]
                    : statement.includes('FROM mart.review_article_rollup')
                      ? [{projectId: 'project-trigger-test'}]
                      : statement.includes('FROM scoped_article')
                        ? [{count: 0}]
                        : []
        }

        const actualProjectAccessGuardModule = await import(projectAccessGuardModulePath + '?actual=' + Date.now())
        const actualServerRuntimeRoleModule = await import(serverRuntimeRoleModulePath + '?actual=' + Date.now())

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  return getMockQueryRows(statement)
                },
              }
            },
          }
        })
        void mock.module(martRefreshServiceModulePath, () => {
          return {
            getDuckdbMartRefreshService: () => {
              return {
                ensureQueueSchema: async () => {},
                flush: async () => {
                  flushCount += 1
                },
                isAutoDrainEnabled: () => {
                  return true
                },
                getProgressSnapshot: () => {
                  return {
                    claimedQueuedArticleIds: [],
                    claimedQueuedProjectIds: [],
                    processingArticleIds: [],
                    processingProjectIds: [],
                  }
                },
                getThroughputSnapshot: () => {
                  return {articleRefreshesPerMinute: null, projectRefreshesPerMinute: null}
                },
              }
            },
          }
        })
        void mock.module(projectAccessGuardModulePath, () => {
          return {...actualProjectAccessGuardModule, assertProjectIsActive: async () => {}}
        })
        void mock.module(serverRuntimeRoleModulePath, () => {
          return {
            ...actualServerRuntimeRoleModule,
            shouldCurrentServerRunWriterWork: () => {
              return true
            },
          }
        })

        const {projectsRoutesGetReviewsWarnings} = await import(routeModulePath + '?flush=' + Date.now())
        const app = new Elysia().use(projectsRoutesGetReviewsWarnings)
        const response = await app.handle(
          new Request('http://localhost/api/projectsreviewswarnings', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({projectId: 'project-trigger-test'}),
          }),
        )

        console.log(JSON.stringify({flushCount, status: response.status}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(
      runScript.stderr.toString() || runScript.stdout.toString() || 'Warnings trigger regression test failed',
    )
  }

  const result = JSON.parse(getLastJsonLine(runScript.stdout.toString())) as {flushCount: number; status: number}

  expect(result.status).toBe(200)
  expect(result.flushCount).toBe(1)
})
