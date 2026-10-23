import {newProjectSystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {
  escapeSqlString,
  getQuotedStringList,
  getSqlLiteral,
  getTimestampLiteral,
} from '../../services/appQueryHelpers.ts'
import {
  getOrCreateImmutablePromptTx,
  immutablePromptIdentityReviewServingFields,
} from '../../services/immutablePromptService.ts'
import {HttpError} from '../../utils/httpError.ts'
import {appendProjectReviewConfigDeltaIfNeeded} from './appendProjectReviewConfigDeltaIfNeeded.ts'
import {assertSelectableProjectModelId} from './assertSelectableProjectModelId.ts'
import {getProjectRow} from './getProjectRow.ts'
import {getProjectValue} from './getProjectValue.ts'
import {getReviewServingSourceTimestamp} from './getReviewServingSourceTimestamp.ts'
import {parseOptionalDate} from './parseOptionalDate.ts'
import {
  getProjectFullTextColumnValuesSql,
  resolveProjectFullTextSettingsOrThrow,
  saveProjectFullTextStrategy,
} from './projectFullTextSettings.ts'
import type {projectsRoutesPostCreateBody} from './projectsRoutesPostCreateBody.ts'
import {upsertProjectPromptTx} from './upsertProjectPromptTx.ts'

export const projectsRoutesPostCreate = async ({body}: {body: typeof projectsRoutesPostCreateBody.static}) => {
  const dateFrom = parseOptionalDate(body.dateFrom)
  const dateTo = parseOptionalDate(body.dateTo)
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new HttpError(400, 'date_from must be on or before date_to')
  }

  await assertSelectableProjectModelId(getAppDatabaseService(), body.modelId)

  const fullTextResolution = await resolveProjectFullTextSettingsOrThrow(
    {
      fullTextChunkPolicy: body.fullTextChunkPolicy ?? null,
      fullTextFigureMode: body.fullTextFigureMode ?? null,
      useFulltext: body.useFulltext ?? false,
    },
    body.modelId,
  )
  const fullTextColumnValues = getProjectFullTextColumnValuesSql(fullTextResolution)

  const newProject = await getAppDatabaseService().transaction(async (tx) => {
    const newProjectId = crypto.randomUUID()
    await saveProjectFullTextStrategy(tx, fullTextResolution)
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
      systemPromptVariant: string | null
      dateFrom: unknown
      dateTo: unknown
      archived: boolean
      createdAt: unknown
      updatedAt: unknown
    }>(`
          INSERT INTO app.project (
            id,
            name,
            description,
            model_id,
            use_title,
            use_abstract,
            use_fulltext,
            use_fulltext_no_images,
            use_metadata,
            system_prompt_variant,
            full_text_figure_mode,
            full_text_chunk_policy,
            full_text_strategy_id,
            date_from,
            date_to
          )
          VALUES (
            '${escapeSqlString(newProjectId)}',
            ${getSqlLiteral(body.name)},
            ${getSqlLiteral(body.description || null)},
            '${escapeSqlString(body.modelId)}',
            ${(body.useTitle ?? true) ? 'TRUE' : 'FALSE'},
            ${(body.useAbstract ?? true) ? 'TRUE' : 'FALSE'},
            ${(body.useFulltext ?? false) ? 'TRUE' : 'FALSE'},
            FALSE,
            ${(body.useMetadata ?? false) ? 'TRUE' : 'FALSE'},
            ${getSqlLiteral(body.systemPromptVariant ?? newProjectSystemPromptVariant)},
            ${fullTextColumnValues.fullTextFigureMode},
            ${fullTextColumnValues.fullTextChunkPolicy},
            ${fullTextColumnValues.fullTextStrategyId},
            ${dateFrom ? getTimestampLiteral(dateFrom) : 'NULL'},
            ${dateTo ? getTimestampLiteral(dateTo) : 'NULL'}
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
            system_prompt_variant AS systemPromptVariant,
            date_from AS dateFrom,
            date_to AS dateTo,
            archived,
            created_at AS createdAt,
            updated_at AS updatedAt
        `)

    if (!createdProject) {
      throw new Error('Failed to create project')
    }

    if (body.prompts && body.prompts.length > 0) {
      const submittedPrompts = (
        body.prompts as Array<string | {content: string; promptHeading?: string; type?: string; order: number}>
      ).filter((prompt) => {
        return typeof prompt === 'string' ? prompt.trim() !== '' : (prompt.content ?? '').trim() !== ''
      })

      for (let index = 0; index < submittedPrompts.length; index++) {
        const prompt = submittedPrompts[index] as
          | string
          | {content: string; promptHeading?: string; type?: string; order: number}
        const content = typeof prompt === 'string' ? prompt : prompt.content
        const heading = typeof prompt === 'object' ? prompt.promptHeading || null : null
        const typeVal = typeof prompt === 'object' ? prompt.type || null : null
        const orderVal = typeof prompt === 'object' && prompt.order !== undefined ? prompt.order : index
        const promptId = await getOrCreateImmutablePromptTx(tx, {
          originalText: content,
          transformedText: null,
          promptHeading: heading,
          type: typeVal,
          archived: false,
        })

        if (!promptId) {
          throw new Error('Prompt not found after insert')
        }

        await upsertProjectPromptTx(tx, {
          changedPromptConfigFields: [...immutablePromptIdentityReviewServingFields, 'promptOrder', 'enabled'],
          criteriaDisposition: null,
          criteriaSectionKey: null,
          criteriaSectionLabel: null,
          projectId: createdProject.id,
          promptId,
          order: orderVal,
          archived: false,
          enabled: true,
          originProjectId: null,
        })
      }
    }

    if (body.existingPromptIds && body.existingPromptIds.length > 0) {
      for (const existing of body.existingPromptIds) {
        const [existingPrompt] = await tx.queryJson<{id: string}>(`
              SELECT id
              FROM app.prompt
              WHERE id = '${escapeSqlString(existing.originalId)}'
              LIMIT 1
            `)

        if (!existingPrompt) {
          throw new HttpError(400, `Existing prompt not found: ${existing.originalId}`)
        }

        await upsertProjectPromptTx(tx, {
          changedPromptConfigFields: [...immutablePromptIdentityReviewServingFields, 'promptOrder', 'enabled'],
          criteriaDisposition: null,
          criteriaSectionKey: null,
          criteriaSectionLabel: null,
          projectId: createdProject.id,
          promptId: existing.originalId,
          order: existing.order,
          archived: false,
          enabled: true,
          originProjectId: null,
        })
      }
    }

    const selectedRoutes = Array.from(
      new Set(
        (body.importRoutes ?? []).filter((route) => {
          return typeof route === 'string' && route.trim() !== ''
        }),
      ),
    )

    if (selectedRoutes.length > 0) {
      const routeRows = await tx.queryJson<{id: string; route: string}>(`
            SELECT id, route
            FROM app.import_route
            WHERE route IN (${getQuotedStringList(selectedRoutes).join(', ')})
          `)

      if (routeRows.length !== selectedRoutes.length) {
        throw new HttpError(400, 'One or more selected import routes are invalid')
      }

      await tx.run(`
            INSERT INTO app.project_import_route (id, project_id, import_route_id)
            VALUES ${routeRows
              .map((row) => {
                return `(${getQuotedStringList([crypto.randomUUID(), createdProject.id, row.id]).join(', ')})`
              })
              .join(', ')}
            ON CONFLICT(project_id, import_route_id) DO NOTHING
          `)
    }

    await appendProjectReviewConfigDeltaIfNeeded(tx, {
      changedReviewConfigFields: [
        'modelId',
        'modelExecutionIdentity',
        'useTitle',
        'useAbstract',
        'useFulltext',
        'useFulltextNoImages',
        'useMetadata',
        'systemPromptVariant',
        'fullTextStrategyId',
        ...(dateFrom ? (['dateFrom'] as const) : []),
        ...(dateTo ? (['dateTo'] as const) : []),
        ...(body.prompts?.length || body.existingPromptIds?.length ? (['promptMembership'] as const) : []),
        ...(selectedRoutes.length > 0 ? (['importRoutes'] as const) : []),
      ],
      projectId: createdProject.id,
      sourceMutationKey: `projectCreate|${createdProject.id}`,
      sourceOperation: 'insert',
      sourceUpdatedAt: getReviewServingSourceTimestamp(createdProject.updatedAt),
    })

    const savedProject = await getProjectRow(tx, createdProject.id)

    if (!savedProject) {
      throw new Error('Failed to read created project')
    }

    return getProjectValue(savedProject)
  })

  return {data: newProject}
}
