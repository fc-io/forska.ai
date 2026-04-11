import {Elysia, t} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getProjectScopeClause, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {getAppQueryService} from '../../services/getAppQueryService.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

export const projectsRoutesGetArticlesReviewsHumanFilters = new Elysia().get(
  '/api/articlesreviewshumanfilters',
  async ({query, set}) => {
    try {
      if (!query?.projectId) {
        set.status = 400
        throw new Error('Project ID is required')
      }

      await assertProjectIsActive(query.projectId)

      const fromDate = query?.from ? new Date(`${query.from}T00:00:00.000Z`) : null
      const toDate = query?.to ? new Date(`${query.to}T23:59:59.999Z`) : null
      const searchTitle = typeof query?.search === 'string' ? query.search.trim() : ''
      const hasDuplicateStudyRecords = query?.covidenceDuplicates === '1'
      const hasStudyDecisionConflict = query?.covidenceConflicts === '1'
      const projectConfig = await getAppQueryService().getProjectReviewConfig(query.projectId)
      const humanJudgmentMode = projectConfig?.humanJudgmentMode ?? 'prompt'

      const projectPromptRows = await getAppQueryService().getProjectPromptRows(query.projectId)

      const scopeCondition = getProjectScopeClause({
        articleAlias: 'a',
        importRouteIds: projectConfig?.importRouteIds ?? [],
        projectId: query.projectId,
      })

      const articleWhereParts = [
        scopeCondition,
        projectConfig?.dateFrom ? `a.article_created_at >= ${getTimestampLiteral(projectConfig.dateFrom)}` : null,
        projectConfig?.dateTo ? `a.article_created_at <= ${getTimestampLiteral(projectConfig.dateTo)}` : null,
        fromDate ? `a.article_created_at >= ${getTimestampLiteral(fromDate)}` : null,
        toDate ? `a.article_created_at <= ${getTimestampLiteral(toDate)}` : null,
        searchTitle ? `LOWER(COALESCE(a.article_title, '')) LIKE LOWER('%${escapeSqlString(searchTitle)}%')` : null,
        hasDuplicateStudyRecords
          ? "LOWER(COALESCE(json_extract_string(a.source_metadata, '$.covidence.hasDuplicateStudyRecords'), 'false')) = 'true'"
          : null,
        hasStudyDecisionConflict
          ? "LOWER(COALESCE(json_extract_string(a.source_metadata, '$.covidence.hasStudyDecisionConflict'), 'false')) = 'true'"
          : null,
      ].filter((part): part is string => {
        return part !== null
      })

      if (humanJudgmentMode === 'summary') {
        const grouped = await getAppDatabaseService().queryJson<{answer: string | null}>(`
          SELECT jhs.answer AS answer
          FROM app.judgment_human_summary jhs
          INNER JOIN app.article a ON a.id = jhs.article_id
          WHERE jhs.project_id = '${escapeSqlString(query.projectId)}'
            AND NULLIF(TRIM(COALESCE(jhs.answer, '')), '') IS NOT NULL
            AND ${articleWhereParts.join(' AND ')}
          GROUP BY jhs.answer
          ORDER BY jhs.answer ASC
        `)

        return {
          filters: [
            {
              promptId: 'summary',
              promptName: 'Overall human screening decision',
              answeredOriginalValues: grouped
                .map((row) => {
                  return row.answer
                })
                .filter((answer): answer is string => {
                  return answer !== null
                }),
            },
          ],
          humanJudgmentMode,
        }
      }

      if (projectPromptRows.length === 0) {
        return {filters: [], humanJudgmentMode}
      }

      const promptIds = projectPromptRows.map((p) => {
        return p.id
      })

      const whereParts = [
        `jh.prompt_id IN (${promptIds
          .map((promptId) => {
            return `'${escapeSqlString(promptId)}'`
          })
          .join(', ')})`,
        'jh.is_answered = TRUE',
        'jh.answer IS NOT NULL',
        ...articleWhereParts,
      ].filter((part): part is string => {
        return part !== null
      })

      const grouped = await getAppDatabaseService().queryJson<{promptId: string; answer: string | null}>(`
        SELECT
          jh.prompt_id AS promptId,
          jh.answer AS answer
        FROM app.judgment_human jh
        INNER JOIN app.article a ON a.id = jh.article_id
        WHERE ${whereParts.join(' AND ')}
        GROUP BY jh.prompt_id, jh.answer
        ORDER BY jh.prompt_id ASC, jh.answer ASC
      `)

      const promptNameMap = new Map(
        projectPromptRows.map((p) => {
          return [p.id, p.promptHeading || p.originalText]
        }),
      )
      const byPrompt = new Map<string, string[]>()
      for (const row of grouped) {
        const arr = byPrompt.get(row.promptId) || []
        if (row.answer !== null) arr.push(row.answer as unknown as string)
        byPrompt.set(row.promptId, arr)
      }

      const result = projectPromptRows.map((p) => {
        return {
          promptId: p.id,
          promptName: promptNameMap.get(p.id) || p.id,
          answeredOriginalValues: byPrompt.get(p.id) || [],
        }
      })

      return {filters: result, humanJudgmentMode}
    } catch (error) {
      console.error('Error fetching human articles reviews filters:', error)
      set.status = 500
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch human articles reviews filters', {
        cause: error,
      })
    }
  },
  {
    query: t.Object({
      projectId: t.String(),
      covidenceConflicts: t.Optional(t.String()),
      covidenceDuplicates: t.Optional(t.String()),
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
