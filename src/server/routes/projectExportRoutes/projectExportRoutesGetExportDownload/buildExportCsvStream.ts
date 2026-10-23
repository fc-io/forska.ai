import {FULL_TEXT_STRATEGY_NONE, getProjectFullTextStrategyIdSql} from '../../../fullText/fullTextStrategy.ts'
import {getFullTextStrategyLabelsById} from '../../../fullText/fullTextStrategyRepository.ts'
import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {getQuotedStringList} from '../../../services/appQueryHelpers.ts'
import {readReviewServingExportArticles} from '../../../services/projectExportReviewServingExportArticleRepository.ts'
import {csvUtf8Bom} from '../../../utils/csvResponse.ts'
import {escapeCSV} from '../escapeCSV.ts'
import {buildExportCsvRows} from './buildExportCsvStream/buildExportCsvRows.ts'
import {getExportHeaders} from './buildExportCsvStream/getExportHeaders.ts'
import {getExportJudgments} from './buildExportCsvStream/getExportJudgments.ts'
import {getExportPromptDetails} from './buildExportCsvStream/getExportPromptDetails.ts'
import type {ExportContract, ExportServingSnapshotScope} from './projectExportDownloadTypes.ts'

const getExportArticles = async (input: {articleIds: string[]; snapshotScopes: ExportServingSnapshotScope[]}) => {
  return readReviewServingExportArticles({...input, database: getAppDatabaseService()})
}

const getExportFullTextStrategyLabels = async (snapshotScopes: ExportServingSnapshotScope[]) => {
  const projectIds = [
    ...new Set(
      snapshotScopes.map((scope) => {
        return scope.projectId
      }),
    ),
  ]
  const rows =
    projectIds.length === 0
      ? []
      : await getAppDatabaseService().queryJson<{fullTextStrategyId: string}>(`
          SELECT DISTINCT ${getProjectFullTextStrategyIdSql('project')} AS fullTextStrategyId
          FROM app.project project
          WHERE project.id IN (${getQuotedStringList(projectIds).join(', ')})
        `)
  const strategyIds = rows.map((row) => {
    return row.fullTextStrategyId
  })

  return strategyIds.some((strategyId) => {
    return strategyId !== FULL_TEXT_STRATEGY_NONE
  })
    ? getFullTextStrategyLabelsById(getAppDatabaseService(), strategyIds)
    : null
}

export const buildExportCsvStream = (input: {
  articleIdBatches: string[][]
  contract: ExportContract
  projectId: string
  snapshotScopes: ExportServingSnapshotScope[]
}) => {
  const encoder = new TextEncoder()

  return new ReadableStream<Uint8Array>({
    start: async (controller) => {
      try {
        const promptOutput = input.contract.promptOutput ?? {}
        const selectedMetadata = input.contract.selectedMetadata ?? {}
        const promptIds = promptOutput.promptIds ?? []
        const promptDetails = await getExportPromptDetails({
          promptIds,
          projectId: input.projectId,
          snapshotScopes: input.snapshotScopes,
        })
        const promptDetailsById = new Map(
          promptDetails.map((prompt) => {
            return [prompt.id, prompt]
          }),
        )
        const orderedPromptDetails = promptIds.flatMap((promptId) => {
          const prompt = promptDetailsById.get(promptId)

          return prompt ? [prompt] : []
        })
        const fullTextStrategyLabels = await getExportFullTextStrategyLabels(input.snapshotScopes)
        const headerRow = getExportHeaders({
          contract: input.contract,
          includeFullTextStrategy: fullTextStrategyLabels !== null,
          orderedPromptDetails,
          selectedMetadata,
        })
          .map(escapeCSV)
          .join(',')

        controller.enqueue(encoder.encode(csvUtf8Bom + headerRow + '\n'))

        await input.articleIdBatches.reduce<Promise<void>>(async (previousBatch, articleIds) => {
          await previousBatch
          const [articles, judgments] = await Promise.all([
            getExportArticles({articleIds, snapshotScopes: input.snapshotScopes}),
            getExportJudgments({
              articleIds,
              promptIds,
              projectId: input.projectId,
              snapshotScopes: input.snapshotScopes,
            }),
          ])
          const batchCsvRows = buildExportCsvRows({
            articles,
            fullTextStrategyLabels,
            judgments,
            orderedPromptIds: orderedPromptDetails.map((prompt) => {
              return prompt.id
            }),
            promptOutput,
            selectedMetadata,
          })

          controller.enqueue(encoder.encode(batchCsvRows.join('\n') + (batchCsvRows.length > 0 ? '\n' : '')))
        }, Promise.resolve())

        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })
}
