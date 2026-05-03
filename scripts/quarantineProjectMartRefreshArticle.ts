import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
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

const quarantineProjectMartRefreshArticle = async () => {
  const articleId = requireArgValue(['--articleId', '--article-id'], '--article-id=<uuid>')
  const error =
    getArgValue(['--error'])
    ?? 'DuckDB/Bun native crash while refreshing judgment_fact for this article. Quarantined pending durable table-refresh repair.'
  const detectedBy = getArgValue(['--detectedBy', '--detected-by']) ?? `manual:${process.pid}`
  const service = getProjectMartDirtyRefreshStateService()

  try {
    const quarantineRecord = await service.quarantineProjectRefreshArticle({articleId, detectedBy, error})
    const impactedProjects = await getAppDatabaseService().queryJson<{projectId: string}>(`
      SELECT DISTINCT project_id AS projectId
      FROM app.project_mart_refresh_article_state
      WHERE article_id = '${articleId}'
      ORDER BY project_id ASC
    `)
    console.log(
      JSON.stringify({
        articleId,
        detectedBy,
        error,
        impactedProjectIds: impactedProjects.map((row) => {
          return row.projectId
        }),
        quarantineRecord,
        status: 'quarantined',
      }),
    )
  } finally {
    await getAppDatabaseService().close()
  }
}

void quarantineProjectMartRefreshArticle()