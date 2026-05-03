import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'

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

const unquarantineProjectMartRefreshArticle = async () => {
  const articleId = requireArgValue(['--articleId', '--article-id'], '--article-id=<uuid>')

  try {
    const impactedProjects = await getAppDatabaseService().queryJson<{projectId: string}>(`
      SELECT DISTINCT project_id AS projectId
      FROM app.project_mart_refresh_article_state
      WHERE article_id = '${articleId}'
      ORDER BY project_id ASC
    `)

    await getAppDatabaseService().run(`
      UPDATE app.project_mart_refresh_article_quarantine
      SET
        resolved_at = current_timestamp,
        updated_at = current_timestamp
      WHERE article_id = '${articleId}'
        AND resolved_at IS NULL
    `)
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
        WHERE article_id = '${articleId}'
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

void unquarantineProjectMartRefreshArticle()
