import type {HumanJudgmentMode} from '../../../db/schemaTypes.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {
  insertComparisonProjectPromptLinks,
  insertComparisonProjectRouteLinks,
  insertComparisonProjectSourceProjectLinks,
} from './comparisonProjectLinkInserts.ts'
import {getComparisonProjectRecordValue} from './comparisonProjectRecord.ts'
import {comparisonProjectTable} from './comparisonProjectRouteConstants.ts'
import type {AppQueryRunner, AppTx, PromptSelection} from './comparisonProjectRouteTypes.ts'
import {
  getSummarySourceProjectId,
  getValidatedComparisonSourceProjectIds,
  getValidatedModelIds,
} from './comparisonProjectSelectionValidation.ts'
import {getBooleanLiteral} from './comparisonProjectSqlClauses.ts'
import {getUniqueStringValues} from './comparisonProjectValueHelpers.ts'
import {getValidatedComparisonPromptSelections} from './getValidatedComparisonPromptSelections.ts'

const getStoredComparisonProjectModelIds = (modelIds: string[]) => {
  return modelIds.length === 0 ? null : modelIds
}

const getComparisonProjectRecordModelIds = async (
  db: AppQueryRunner,
  modelIds: string[],
  validateModelIds: boolean,
) => {
  const uniqueModelIds = getUniqueStringValues(modelIds)

  return validateModelIds
    ? getValidatedModelIds(db, uniqueModelIds)
    : getStoredComparisonProjectModelIds(uniqueModelIds)
}

export const createComparisonProjectRecord = async (
  tx: AppTx,
  body: {
    name: string
    description?: string | null
    modelIds?: string[]
    compareWithHumans?: boolean
    allowConflictResolution?: boolean
    humanJudgmentMode?: HumanJudgmentMode
    summarySourceProjectId?: string | null
    useTitle?: boolean
    useAbstract?: boolean
    useFulltext?: boolean
    useFulltextNoImages?: boolean
    importRoutes?: string[]
    sourceProjectIds?: string[]
    promptSelections?: PromptSelection[]
    validateModelIds?: boolean
  },
): Promise<ReturnType<typeof getComparisonProjectRecordValue>> => {
  const useTitle = body.useTitle ?? true
  const useAbstract = body.useAbstract ?? true
  const useFulltext = body.useFulltext ?? false
  const useFulltextNoImages = body.useFulltextNoImages ?? false

  if (!useTitle && !useAbstract && !useFulltext && !useFulltextNoImages) {
    throw new Error('Select at least one article content option to compare')
  }

  const comparisonProjectModelIds = await getComparisonProjectRecordModelIds(
    tx,
    body.modelIds ?? [],
    body.validateModelIds ?? true,
  )
  const humanJudgmentMode = body.humanJudgmentMode ?? 'prompt'
  const summarySourceProjectId =
    humanJudgmentMode === 'summary' ? getSummarySourceProjectId(body.summarySourceProjectId) : null
  const validatedPromptSelections = await getValidatedComparisonPromptSelections(tx, {
    compareWithHumans: body.compareWithHumans ?? false,
    humanJudgmentMode,
    promptSelections: body.promptSelections ?? [],
    summarySourceProjectId,
  })
  const uniqueImportRoutes = getUniqueStringValues(body.importRoutes ?? [])
  const validatedSourceProjectIds = await getValidatedComparisonSourceProjectIds(tx, body.sourceProjectIds ?? [])
  const [newComparisonProject] = await tx.queryJson<{
    id: string
    name: string
    description: string | null
    modelIds: unknown
    compareWithHumans: boolean
    allowConflictResolution: boolean
    humanJudgmentMode: HumanJudgmentMode | null
    summarySourceProjectId: string | null
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    archived: boolean
    createdAt: unknown
    updatedAt: unknown
  }>(`
    INSERT INTO ${comparisonProjectTable} (
      id,
      name,
      description,
      model_ids,
      compare_with_humans,
      allow_conflict_resolution,
      human_judgment_mode,
      summary_source_project_id,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images
    )
    VALUES (
      ${getSqlLiteral(crypto.randomUUID())},
      ${getSqlLiteral(body.name)},
      ${getSqlLiteral(body.description?.trim() || null)},
      ${getSqlLiteral(comparisonProjectModelIds)},
      ${getBooleanLiteral(body.compareWithHumans ?? false)},
      ${getBooleanLiteral(body.allowConflictResolution ?? false)},
      ${getSqlLiteral(humanJudgmentMode)},
      ${getSqlLiteral(summarySourceProjectId)},
      ${getBooleanLiteral(useTitle)},
      ${getBooleanLiteral(useAbstract)},
      ${getBooleanLiteral(useFulltext)},
      ${getBooleanLiteral(useFulltextNoImages)}
    )
    RETURNING
      id,
      name,
      description,
      model_ids AS modelIds,
      compare_with_humans AS compareWithHumans,
      allow_conflict_resolution AS allowConflictResolution,
      human_judgment_mode AS humanJudgmentMode,
      summary_source_project_id AS summarySourceProjectId,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      archived,
      created_at AS createdAt,
      updated_at AS updatedAt
  `)

  if (!newComparisonProject) {
    throw new Error('Failed to create comparison project')
  }

  await insertComparisonProjectPromptLinks(tx, newComparisonProject.id, validatedPromptSelections)
  await insertComparisonProjectRouteLinks(tx, newComparisonProject.id, uniqueImportRoutes)
  await insertComparisonProjectSourceProjectLinks(tx, newComparisonProject.id, validatedSourceProjectIds)

  return getComparisonProjectRecordValue(newComparisonProject)
}
