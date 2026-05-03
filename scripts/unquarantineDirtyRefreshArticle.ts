import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getSqlLiteral} from '../src/server/services/appQueryHelpers.ts'
import {getProjectMartDirtyRefreshStateService} from '../src/server/services/projectMartDirtyRefreshStateService.ts'

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1).trim()
}

const requireArgValue = (names: string[], description: string) => {
  const value = getArgValue(names)

  if (!value) {
    throw new Error(`Missing ${description}`)
  }

  return value
}

const getImpactedProjects = async (articleId: string) => {
  return getAppDatabaseService().queryJson<{projectId: string}>(`
    SELECT DISTINCT project_id AS projectId
    FROM app.project_mart_refresh_article_state
    WHERE article_id = ${getSqlLiteral(articleId)}
    ORDER BY project_id ASC
  `)
}

export const unquarantineDirtyRefreshArticle = async () => {
  const articleId = requireArgValue(['--articleId', '--article-id'], '--article-id=<uuid>')

  try {
    const impactedProjects = await getImpactedProjects(articleId)

    await impactedProjects.reduce<Promise<void>>(async (accPromise, project) => {
      await accPromise
      await getProjectMartDirtyRefreshStateService().resolveProjectRefreshArticleQuarantine({
        articleId,
        projectId: project.projectId,
      })
    }, Promise.resolve())
    await getAppDatabaseService().run(`
      UPDATE app.project_mart_refresh_state
      SET
        refresh_status = 'idle',
        last_error = NULL,
        worker_id = NULL,
        lease_expires_at = NULL,
        active_dirty_token = 0,
        updated_at = current_timestamp
      WHERE project_id IN (
        SELECT DISTINCT project_id
        FROM app.project_mart_refresh_article_state
        WHERE article_id = ${getSqlLiteral(articleId)}
      )
        AND refresh_status IN ('blocked_by_quarantine', 'failed')
    `)

    console.log(
      JSON.stringify({
        articleId,
        impactedProjectIds: impactedProjects.map((row) => {
          return row.projectId
        }),
        status: 'unquarantined',
      }),
    )
  } finally {
    await getAppDatabaseService().close()
  }
}

if (import.meta.main) {
  await unquarantineDirtyRefreshArticle()
}
