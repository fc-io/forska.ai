import {appendHumanJudgmentReviewServingDeltas} from '../../../reviewServing/humanJudgmentReviewServingDeltaService.ts'
import {appendProjectScopeArticleReviewServingDeltas} from '../../../reviewServing/projectScopeReviewServingDeltaService.ts'
import {appendPromptConfigReviewServingDelta} from '../../../reviewServing/reviewConfigReviewServingDeltaService.ts'
import {escapeSqlString, getQuotedStringList, getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {immutablePromptIdentityReviewServingFields} from '../../../services/immutablePromptService.ts'
import {appendProjectReviewConfigDeltaIfNeeded} from '../appendProjectReviewConfigDeltaIfNeeded.ts'
import type {AppTx} from '../appTx.ts'

const hasNonEmptyHumanAnswer = (answer: string | null) => {
  return typeof answer === 'string' && answer.trim().length > 0
}

export const copyCloneSourceRowsTx = async (
  tx: AppTx,
  {
    clonedProject,
    params,
    sourceProject,
  }: {
    clonedProject: {id: string}
    params: {id: string}
    sourceProject: {dateFrom: Date | null; dateTo: Date | null; humanJudgmentMode: 'prompt' | 'summary' | null}
  },
) => {
  const [sourcePrompts, sourceRouteLinks, sourceArticles, sourceSummaryJudgments] = await Promise.all([
    tx.queryJson<{
      promptId: string
      order: number | null
      archived: boolean
      enabled: boolean
      originalText: string
      transformedText: string | null
      promptHeading: string | null
      type: string | null
      promptArchived: boolean
      criteriaDisposition: 'include' | 'exclude' | 'combined' | null
      criteriaSectionKey: string | null
      criteriaSectionLabel: string | null
    }>(`
          SELECT
            pp.prompt_id AS promptId,
            pp.prompt_order AS "order",
            pp.archived AS archived,
            pp.enabled AS enabled,
            p.original_text AS originalText,
            p.transformed_text AS transformedText,
            p.prompt_heading AS promptHeading,
            p.type AS type,
            p.archived AS promptArchived,
            pp.criteria_disposition AS criteriaDisposition,
            pp.criteria_section_key AS criteriaSectionKey,
            pp.criteria_section_label AS criteriaSectionLabel
          FROM app.project_prompt pp
          INNER JOIN app.prompt p ON p.id = pp.prompt_id
          WHERE pp.project_id = '${escapeSqlString(params.id)}'
          ORDER BY pp.prompt_order ASC NULLS LAST
        `),
    tx.queryJson<{importRouteId: string}>(`
          SELECT import_route_id AS importRouteId
          FROM app.project_import_route
          WHERE project_id = '${escapeSqlString(params.id)}'
        `),
    tx.queryJson<{articleId: string}>(`
          SELECT article_id AS articleId
          FROM app.project_article
          WHERE project_id = '${escapeSqlString(params.id)}'
        `),
    sourceProject.humanJudgmentMode === 'summary'
      ? tx.queryJson<{answer: string | null; articleId: string; origin: 'covidence_import' | 'manual_override'}>(`
              SELECT article_id AS articleId, answer, origin
              FROM app.judgment_human_summary
              WHERE project_id = '${escapeSqlString(params.id)}'
            `)
      : Promise.resolve([]),
  ])

  if (sourcePrompts.length > 0) {
    for (const prompt of sourcePrompts) {
      await tx.run(`
            INSERT INTO app.project_prompt (
              id,
              project_id,
              prompt_id,
              prompt_order,
              archived,
              enabled,
              origin_project_id,
              criteria_disposition,
              criteria_section_key,
              criteria_section_label
            )
            VALUES (
              '${escapeSqlString(crypto.randomUUID())}',
              '${escapeSqlString(clonedProject.id)}',
              '${escapeSqlString(prompt.promptId)}',
              ${prompt.order ?? 0},
              ${prompt.archived ? 'TRUE' : 'FALSE'},
              ${prompt.enabled ? 'TRUE' : 'FALSE'},
              NULL,
              ${getSqlLiteral(prompt.criteriaDisposition)},
              ${getSqlLiteral(prompt.criteriaSectionKey)},
              ${getSqlLiteral(prompt.criteriaSectionLabel)}
            )
          `)
      await appendPromptConfigReviewServingDelta(tx, {
        changedPromptConfigFields: [
          ...immutablePromptIdentityReviewServingFields,
          'promptOrder',
          'archived',
          'enabled',
          'thresholding',
        ],
        projectId: clonedProject.id,
        promptId: prompt.promptId,
        sourceMutationKey: `projectClonePrompt|${params.id}|${clonedProject.id}|${prompt.promptId}`,
        sourceOperation: 'insert',
      })
    }
  }

  if (sourceRouteLinks.length > 0) {
    await tx.run(`
          INSERT INTO app.project_import_route (id, project_id, import_route_id)
          VALUES ${sourceRouteLinks
            .map((link) => {
              return `(${getQuotedStringList([crypto.randomUUID(), clonedProject.id, link.importRouteId]).join(', ')})`
            })
            .join(', ')}
        `)
  }

  if (sourceArticles.length > 0) {
    const projectArticleRows = sourceArticles.map((article) => {
      return {articleId: article.articleId, projectArticleId: crypto.randomUUID()}
    })

    await tx.run(`
          INSERT INTO app.project_article (id, project_id, article_id, imported_from_project_id)
          VALUES ${projectArticleRows
            .map((row) => {
              return `(${getQuotedStringList([row.projectArticleId, clonedProject.id, row.articleId, params.id]).join(', ')})`
            })
            .join(', ')}
        `)

    await appendProjectScopeArticleReviewServingDeltas(
      tx,
      projectArticleRows.map((row) => {
        return {
          articleId: row.articleId,
          changeKind: 'projectScope.article.added' as const,
          projectArticleId: row.projectArticleId,
          projectId: clonedProject.id,
          sourceMutationKey: `projectCloneArticle|${params.id}|${clonedProject.id}|${row.projectArticleId}`,
          sourceOperation: 'insert' as const,
        }
      }),
    )
  }

  if (sourceProject.humanJudgmentMode === 'summary' && sourceSummaryJudgments.length > 0) {
    await tx.run(`
          INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin)
          VALUES ${sourceSummaryJudgments
            .map((judgment) => {
              return `(${getQuotedStringList([crypto.randomUUID(), clonedProject.id, judgment.articleId]).join(', ')}, ${getSqlLiteral(judgment.answer)}, ${getSqlLiteral(judgment.origin)})`
            })
            .join(', ')}
        `)
    await appendHumanJudgmentReviewServingDeltas(
      tx,
      sourceSummaryJudgments
        .filter((judgment) => {
          return hasNonEmptyHumanAnswer(judgment.answer)
        })
        .map((judgment) => {
          const humanJudgmentKey = `${clonedProject.id}:${judgment.articleId}:summary`

          return {
            answer: judgment.answer,
            articleId: judgment.articleId,
            humanJudgmentKey,
            projectId: clonedProject.id,
            sourceMutationKey: `projectCloneHumanSummary|${params.id}|${humanJudgmentKey}`,
            sourceOperation: 'insert' as const,
            sourceRowId: humanJudgmentKey,
            sourceTable: 'app.judgment_human_summary',
          }
        }),
    )
  }

  await appendProjectReviewConfigDeltaIfNeeded(tx, {
    changedReviewConfigFields: [
      'modelId',
      'modelExecutionIdentity',
      'humanJudgmentMode',
      'useTitle',
      'useAbstract',
      'useFulltext',
      'useFulltextNoImages',
      'useMetadata',
      'systemPromptVariant',
      ...(sourceProject.dateFrom ? (['dateFrom'] as const) : []),
      ...(sourceProject.dateTo ? (['dateTo'] as const) : []),
      ...(sourcePrompts.length > 0 ? (['promptMembership'] as const) : []),
      ...(sourceRouteLinks.length > 0 ? (['importRoutes'] as const) : []),
    ],
    projectId: clonedProject.id,
    sourceMutationKey: `projectClone|${params.id}|${clonedProject.id}`,
    sourceOperation: 'insert',
  })
}
