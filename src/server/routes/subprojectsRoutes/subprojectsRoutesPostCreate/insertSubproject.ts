import {appendProjectScopeArticleReviewServingDeltas} from '../../../reviewServing/projectScopeReviewServingDeltaService.ts'
import {
  appendProjectReviewConfigReviewServingDelta,
  appendPromptConfigReviewServingDeltas,
} from '../../../reviewServing/reviewConfigReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import * as appQueryHelpers from '../../../services/appQueryHelpers.ts'
import {
  getOrCreateImmutablePromptTx,
  immutablePromptIdentityReviewServingFields,
} from '../../../services/immutablePromptService.ts'
import type {subprojectsRoutesPostCreateBody} from '../subprojectsRoutesPostCreateBody.ts'
import {chunk} from './chunk.ts'
import {getSubprojectSystemPromptVariant} from './getSubprojectSystemPromptVariant.ts'
import {getSubprojectUseMetadata} from './getSubprojectUseMetadata.ts'
import {linkProjectPromptTx} from './linkProjectPromptTx.ts'
import type {ProjectBound, PromptRow} from './subprojectTypes.ts'

export const insertSubproject = async ({
  articleIds,
  body,
  orderedPromptDetails,
  projectBounds,
}: {
  articleIds: string[]
  body: typeof subprojectsRoutesPostCreateBody.static
  orderedPromptDetails: PromptRow[]
  projectBounds: ProjectBound[]
}) => {
  const appDatabaseService = getAppDatabaseService()
  const batchSize = 5000
  const newProject = (await appDatabaseService.transaction(async (tx) => {
    const newProjectId = crypto.randomUUID()
    const [createdProject] = await tx.queryJson<{
      id: string
      name: string
      description: string | null
      modelId: string
      useTitle: boolean
      useAbstract: boolean
      useFulltext: boolean
      useFulltextNoImages: boolean
      useMetadata: boolean
      dateFrom: unknown
      dateTo: unknown
      updatedAt: Date | string
    }>(`
          INSERT INTO app.project (
            id,
            name,
            description,
            model_id,
            use_title,
            use_abstract,
            use_fulltext,
            use_metadata,
            system_prompt_variant,
            date_from,
            date_to
          )
          VALUES (
            '${appQueryHelpers.escapeSqlString(newProjectId)}',
            ${appQueryHelpers.getSqlLiteral(body.name)},
            ${appQueryHelpers.getSqlLiteral(body.description || null)},
            ${appQueryHelpers.getSqlLiteral(body.modelId)},
            TRUE,
            TRUE,
            FALSE,
            ${getSubprojectUseMetadata(projectBounds) ? 'TRUE' : 'FALSE'},
            ${appQueryHelpers.getSqlLiteral(getSubprojectSystemPromptVariant(projectBounds))},
            ${appQueryHelpers.getSqlLiteral(body.dateFrom ? new Date(body.dateFrom) : null)},
            ${appQueryHelpers.getSqlLiteral(body.dateTo ? new Date(body.dateTo) : null)}
          )
          RETURNING
            id,
            name,
            description,
            model_id AS modelId,
            use_title AS useTitle,
            use_abstract AS useAbstract,
            use_fulltext AS useFulltext,
            use_fulltext_no_images AS useFulltextNoImages,
            COALESCE(use_metadata, FALSE) AS useMetadata,
            date_from AS dateFrom,
            date_to AS dateTo,
            updated_at AS updatedAt
        `)

    if (!createdProject) {
      throw new Error('Failed to create project')
    }

    const linkedPromptIds: string[] = []

    for (const [orderIndex, prompt] of orderedPromptDetails.entries()) {
      const targetPromptId = await getOrCreateImmutablePromptTx(tx, {
        archived: prompt.archived,
        originalText: prompt.originalText,
        promptHeading: prompt.promptHeading,
        transformedText: prompt.transformedText,
        type: prompt.type,
      })

      if (!targetPromptId) {
        throw new Error('Failed to create detached subproject prompt')
      }

      await linkProjectPromptTx(tx, {order: orderIndex, projectId: createdProject.id, promptId: targetPromptId})
      linkedPromptIds.push(targetPromptId)
    }

    await appendProjectReviewConfigReviewServingDelta(tx, {
      changedReviewConfigFields: [
        'modelId',
        'modelExecutionIdentity',
        'useTitle',
        'useAbstract',
        'useFulltext',
        'useFulltextNoImages',
        'useMetadata',
        'systemPromptVariant',
        ...(body.dateFrom ? (['dateFrom'] as const) : []),
        ...(body.dateTo ? (['dateTo'] as const) : []),
        ...(linkedPromptIds.length > 0 ? (['promptMembership'] as const) : []),
      ],
      projectId: createdProject.id,
      sourceMutationKey: `SubprojectsRoutes.projectConfig|${createdProject.id}|${String(createdProject.updatedAt)}`,
      sourceOperation: 'insert',
      sourceUpdatedAt: createdProject.updatedAt,
    })

    await appendPromptConfigReviewServingDeltas(
      tx,
      linkedPromptIds.map((promptId) => {
        return {
          changedPromptConfigFields: [...immutablePromptIdentityReviewServingFields, 'promptOrder', 'enabled'],
          projectId: createdProject.id,
          promptId,
          sourceMutationKey: `SubprojectsRoutes.promptConfig|${createdProject.id}|${promptId}|${String(createdProject.updatedAt)}`,
          sourceOperation: 'insert' as const,
          sourceUpdatedAt: createdProject.updatedAt,
        }
      }),
    )

    for (const idsChunk of chunk(articleIds, batchSize)) {
      if (idsChunk.length === 0) {
        continue
      }

      const projectArticleRows = idsChunk.map((articleId) => {
        return {articleId, projectArticleId: crypto.randomUUID()}
      })

      await tx.run(`
            INSERT INTO app.project_article (id, project_id, article_id, imported_from_project_id)
            VALUES ${projectArticleRows
              .map((row) => {
                return `('${appQueryHelpers.escapeSqlString(row.projectArticleId)}', '${appQueryHelpers.escapeSqlString(createdProject.id)}', '${appQueryHelpers.escapeSqlString(row.articleId)}', NULL)`
              })
              .join(', ')}
            ON CONFLICT DO NOTHING
          `)

      await appendProjectScopeArticleReviewServingDeltas(
        tx,
        projectArticleRows.map((row) => {
          return {
            articleId: row.articleId,
            changeKind: 'projectScope.article.added' as const,
            projectArticleId: row.projectArticleId,
            projectId: createdProject.id,
            sourceMutationKey: `SubprojectsRoutes.post|${createdProject.id}|${row.projectArticleId}`,
            sourceOperation: 'insert' as const,
          }
        }),
      )
    }

    return createdProject
  })) as {
    id: string
    name: string
    description: string | null
    modelId: string
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    useMetadata: boolean
    dateFrom: unknown
    dateTo: unknown
    updatedAt: Date | string
  }

  return newProject
}
