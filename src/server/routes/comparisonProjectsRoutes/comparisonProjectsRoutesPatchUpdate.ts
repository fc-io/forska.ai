import {Elysia, t} from 'elysia'

import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {rejectLegacyFullTextNoImagesBody} from '../../utils/rejectLegacyFullTextNoImagesBody.ts'
import {
  insertComparisonProjectPromptLinks,
  insertComparisonProjectRouteLinks,
  insertComparisonProjectSourceProjectLinks,
} from './comparisonProjectLinkInserts.ts'
import {checkpointComparisonProjectMutation} from './comparisonProjectMutationCheckpoint.ts'
import {getComparisonProjectRecordValue, updateComparisonProjectTx} from './comparisonProjectRecord.ts'
import {
  comparisonProjectImportRouteTable,
  comparisonProjectPromptTable,
  comparisonProjectSourceProjectTable,
  comparisonProjectTable,
} from './comparisonProjectRouteConstants.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {AppTx, ComparisonProjectRecordRow, PromptSelection} from './comparisonProjectRouteTypes.ts'
import {
  getSummarySourceProjectId,
  getValidatedComparisonSourceProjectIds,
  getValidatedModelIds,
} from './comparisonProjectSelectionValidation.ts'
import {markComparisonProjectServingStaleAndQueueRebuild} from './comparisonProjectServingRebuildQueue.ts'
import {
  assertComparisonProjectSourceProjectIdsShareFullTextStrategy,
  getComparisonProjectBodySourceProjectIds,
} from './comparisonProjectSourceFullTextStrategy.ts'
import {getBooleanLiteral} from './comparisonProjectSqlClauses.ts'
import {getUniqueStringValues} from './comparisonProjectValueHelpers.ts'
import {getComparisonProjectEditFormData} from './getComparisonProjectEditFormData.ts'
import {getValidatedComparisonPromptSelections} from './getValidatedComparisonPromptSelections.ts'

const deleteComparisonProjectLinkRows = async (tx: AppTx, tableName: string, comparisonProjectId: string) => {
  await tx.run(`
    DELETE FROM ${tableName}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
  `)
}

const hasSameStringArrayValue = (left: string[] | null, right: string[] | null) => {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
}

const getDuckdbStringArrayValue = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => {
      return typeof entry === 'string'
    })
  }

  if (typeof value !== 'string') {
    return null
  }

  const trimmedValue = value.trim()

  if (trimmedValue === '[]') {
    return []
  }

  if (!trimmedValue.startsWith('[') || !trimmedValue.endsWith(']')) {
    return null
  }

  return trimmedValue
    .slice(1, -1)
    .split(',')
    .map((part) => {
      return part.trim()
    })
    .filter((part) => {
      return part !== ''
    })
}

const updateComparisonProjectWithRelinkedLinks = async (params: {
  comparisonProjectId: string
  importRoutes?: string[]
  setParts: string[]
  sourceProjectIds?: string[]
  promptSelections: PromptSelection[]
}): Promise<ComparisonProjectRecordRow | null> => {
  return appDatabaseService.transaction(async (tx) => {
    const updatedComparisonProjectRecord = await updateComparisonProjectTx(tx, {
      comparisonProjectId: params.comparisonProjectId,
      setParts: params.setParts,
    })

    if (!updatedComparisonProjectRecord) {
      throw new Error('Comparison project not found')
    }

    await deleteComparisonProjectLinkRows(tx, comparisonProjectPromptTable, params.comparisonProjectId)
    await insertComparisonProjectPromptLinks(tx, params.comparisonProjectId, params.promptSelections)

    if (params.importRoutes !== undefined) {
      await deleteComparisonProjectLinkRows(tx, comparisonProjectImportRouteTable, params.comparisonProjectId)
      await insertComparisonProjectRouteLinks(tx, params.comparisonProjectId, params.importRoutes)
    }

    if (params.sourceProjectIds !== undefined) {
      await deleteComparisonProjectLinkRows(tx, comparisonProjectSourceProjectTable, params.comparisonProjectId)
      await insertComparisonProjectSourceProjectLinks(tx, params.comparisonProjectId, params.sourceProjectIds)
    }

    return updatedComparisonProjectRecord
  }) as Promise<ComparisonProjectRecordRow | null>
}

export const comparisonProjectsRoutesPatchUpdate = new Elysia().patch(
  '/api/comparison-projects/:id',
  async (context) => {
    const {params, body, set} = context
    const existingComparisonProject = await getComparisonProjectEditFormData(params.id)

    if (!existingComparisonProject) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    const useTitle = body.useTitle
    const useAbstract = body.useAbstract
    const useFulltext = body.useFulltext
    const useFulltextNoImages = existingComparisonProject.useFulltextNoImages

    if (!useTitle && !useAbstract && !useFulltext && !useFulltextNoImages) {
      throw new Error('Select at least one article content option to compare')
    }

    const validatedModelIds = await getValidatedModelIds(appDatabaseService, getUniqueStringValues(body.modelIds ?? []))
    const [existingModelIdsRow] = await appDatabaseService.queryJson<{modelIds: unknown}>(`
        SELECT model_ids AS modelIds
        FROM ${comparisonProjectTable}
        WHERE id = ${getSqlLiteral(params.id)}
        LIMIT 1
      `)
    const existingModelIds = getDuckdbStringArrayValue(existingModelIdsRow?.modelIds)
    const humanJudgmentMode = body.humanJudgmentMode ?? existingComparisonProject.humanJudgmentMode
    const summarySourceProjectId =
      humanJudgmentMode === 'summary'
        ? getSummarySourceProjectId(body.summarySourceProjectId ?? existingComparisonProject.summarySourceProjectId)
        : null
    const validatedPromptSelections = await getValidatedComparisonPromptSelections(appDatabaseService, {
      compareWithHumans: body.compareWithHumans,
      humanJudgmentMode,
      promptSelections: body.promptSelections,
      summarySourceProjectId,
    })
    const uniqueImportRoutes =
      body.importRoutes === undefined ? undefined : getUniqueStringValues(body.importRoutes ?? [])
    const validatedSourceProjectIds =
      body.sourceProjectIds === undefined
        ? undefined
        : await getValidatedComparisonSourceProjectIds(appDatabaseService, body.sourceProjectIds ?? [])

    if (
      validatedSourceProjectIds !== undefined
      && !hasSameStringArrayValue(
        [...validatedSourceProjectIds].sort(),
        [...existingComparisonProject.sourceProjectIds].sort(),
      )
    ) {
      await assertComparisonProjectSourceProjectIdsShareFullTextStrategy(
        appDatabaseService,
        getComparisonProjectBodySourceProjectIds({
          humanJudgmentMode,
          sourceProjectIds: validatedSourceProjectIds,
          summarySourceProjectId,
        }),
      )
    }
    const baseSetParts = [
      `name = ${getSqlLiteral(body.name)}`,
      `description = ${getSqlLiteral(body.description?.trim() || null)}`,
      `compare_with_humans = ${getBooleanLiteral(body.compareWithHumans)}`,
      `allow_conflict_resolution = ${getBooleanLiteral(body.allowConflictResolution)}`,
      `human_judgment_mode = ${getSqlLiteral(humanJudgmentMode)}`,
      `summary_source_project_id = ${getSqlLiteral(summarySourceProjectId)}`,
      `use_title = ${getBooleanLiteral(useTitle)}`,
      `use_abstract = ${getBooleanLiteral(useAbstract)}`,
      `use_fulltext = ${getBooleanLiteral(useFulltext)}`,
      `use_fulltext_no_images = ${getBooleanLiteral(useFulltextNoImages)}`,
      `updated_at = current_timestamp`,
    ]
    const hasModelIdsChange = !hasSameStringArrayValue(validatedModelIds, existingModelIds)
    const setParts = hasModelIdsChange
      ? [...baseSetParts, `model_ids = ${getSqlLiteral(validatedModelIds)}`]
      : baseSetParts

    const updatedComparisonProjectRow = await updateComparisonProjectWithRelinkedLinks({
      comparisonProjectId: params.id,
      importRoutes: uniqueImportRoutes,
      setParts,
      sourceProjectIds: validatedSourceProjectIds,
      promptSelections: validatedPromptSelections,
    })

    if (!updatedComparisonProjectRow) {
      throw new Error('Comparison project not found')
    }

    await checkpointComparisonProjectMutation()
    await markComparisonProjectServingStaleAndQueueRebuild(params.id)

    return {data: getComparisonProjectRecordValue(updatedComparisonProjectRow)}
  },
  {
    transform: rejectLegacyFullTextNoImagesBody,
    body: t.Object({
      name: t.String(),
      description: t.Optional(t.Union([t.String(), t.Null()])),
      compareWithHumans: t.Boolean(),
      allowConflictResolution: t.Boolean(),
      humanJudgmentMode: t.Optional(t.Union([t.Literal('prompt'), t.Literal('summary')])),
      summarySourceProjectId: t.Optional(t.Union([t.String(), t.Null()])),
      modelIds: t.Optional(t.Array(t.String())),
      useTitle: t.Boolean(),
      useAbstract: t.Boolean(),
      useFulltext: t.Boolean(),
      importRoutes: t.Optional(t.Array(t.String())),
      sourceProjectIds: t.Optional(t.Array(t.String())),
      promptSelections: t.Array(t.Object({promptId: t.String(), order: t.Number()})),
    }),
  },
)
