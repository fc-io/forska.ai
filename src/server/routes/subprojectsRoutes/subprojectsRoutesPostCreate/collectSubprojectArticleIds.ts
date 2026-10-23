import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import * as appQueryHelpers from '../../../services/appQueryHelpers.ts'
import type {subprojectsRoutesPostCreateBody} from '../subprojectsRoutesPostCreateBody.ts'
import {chunk} from './chunk.ts'
import {getProjectArticleWhereClause} from './getProjectArticleWhereClause.ts'
import {queryAllArticlesInScope} from './queryAllArticlesInScope.ts'
import {queryArticlesWithPromptFilters} from './queryArticlesWithPromptFilters.ts'
import type {ProjectBound, PromptFilter} from './subprojectTypes.ts'

export const collectSubprojectArticleIds = async ({
  allSelectedPromptIds,
  body,
  importRouteIdsByProjectId,
  projectBounds,
  promptFilters,
}: {
  allSelectedPromptIds: string[]
  body: typeof subprojectsRoutesPostCreateBody.static
  importRouteIdsByProjectId: Map<string, string[]>
  projectBounds: ProjectBound[]
  promptFilters: PromptFilter[]
}) => {
  const appDatabaseService = getAppDatabaseService()
  const promptIdsForMapping = allSelectedPromptIds.length > 0 ? Array.from(new Set(allSelectedPromptIds)) : []
  const promptIdsByProjectId = new Map<string, Set<string>>()

  if (body.sourceProjectIds.length > 0 && promptIdsForMapping.length > 0) {
    const projectPromptRows = await appDatabaseService.queryJson<{projectId: string; promptId: string}>(`
          SELECT
            project_id AS projectId,
            prompt_id AS promptId
          FROM app.project_prompt
          WHERE project_id IN (${appQueryHelpers.getQuotedStringList(body.sourceProjectIds).join(', ')})
            AND prompt_id IN (${appQueryHelpers.getQuotedStringList(promptIdsForMapping).join(', ')})
            AND enabled = TRUE
        `)

    for (const row of projectPromptRows) {
      const current = promptIdsByProjectId.get(row.projectId) ?? new Set<string>()
      current.add(row.promptId)
      promptIdsByProjectId.set(row.projectId, current)
    }
  }

  const userDateFrom = body.dateFrom ? new Date(`${body.dateFrom}T00:00:00.000Z`) : null
  const userDateTo = body.dateTo ? new Date(`${body.dateTo}T23:59:59.999Z`) : null
  const uniqueArticleIds = new Set<string>()
  const projectQueryConcurrency = 3

  for (const boundsChunk of chunk(projectBounds, projectQueryConcurrency)) {
    const chunkResults = await Promise.all(
      boundsChunk.map(async (sourceProject) => {
        const projectPromptIdSet = promptIdsByProjectId.get(sourceProject.id) ?? new Set<string>()
        const applicablePromptFilters = promptFilters.filter((filter) => {
          return projectPromptIdSet.has(filter.promptId)
        })
        const applicablePromptIds = applicablePromptFilters.map((filter) => {
          return filter.promptId
        })
        const projectWhereClause = appQueryHelpers.getAndClause([
          getProjectArticleWhereClause({
            projectId: sourceProject.id,
            routeIds: importRouteIdsByProjectId.get(sourceProject.id) ?? [],
            dateFrom: sourceProject.dateFrom,
            dateTo: sourceProject.dateTo,
          }),
          userDateFrom ? `a.article_created_at >= ${appQueryHelpers.getSqlLiteral(userDateFrom)}` : null,
          userDateTo ? `a.article_created_at <= ${appQueryHelpers.getSqlLiteral(userDateTo)}` : null,
        ])

        return applicablePromptFilters.length > 0
          ? queryArticlesWithPromptFilters(
              applicablePromptFilters,
              applicablePromptIds,
              [sourceProject],
              projectWhereClause,
            ).then((rows) => {
              return rows.map((row) => {
                return row.id
              })
            })
          : queryAllArticlesInScope(projectWhereClause).then((rows) => {
              return rows.map((row) => {
                return row.id
              })
            })
      }),
    )

    for (const ids of chunkResults) {
      for (const id of ids) {
        uniqueArticleIds.add(id)
      }
    }
  }

  const articleIds = Array.from(uniqueArticleIds)
  console.log(
    `[subprojects] Found ${articleIds.length} articles matching criteria across ${projectBounds.length} projects`,
  )

  return articleIds
}
