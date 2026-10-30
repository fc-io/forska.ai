import type {ComparisonProjectCovidenceExportSelection} from '../../../../utils/comparisonProjectCovidenceExportSelection.ts'
import {readComparisonProjectCovidenceExportArticles} from '../../../services/comparisonProjectCovidenceExportArticleRepository.ts'
import {appDatabaseService} from '../comparisonProjectRouteServices.ts'
import type {ComparisonProjectScope} from '../comparisonProjectScopeTypes.ts'
import type {ComparisonProjectExportRow} from '../comparisonProjectsRoutesPostExport/comparisonProjectExportRow.ts'
import {
  type ComparisonProjectCovidenceExportArticle,
  getComparisonProjectCovidenceExportArticle,
} from './comparisonProjectCovidenceExportArticle.ts'
import {getComparisonProjectCovidenceExportRisRecord} from './comparisonProjectCovidenceExportRisRecord.ts'
import {forEachComparisonProjectCovidenceExportRowBatch} from './forEachComparisonProjectCovidenceExportRowBatch.ts'

const comparisonProjectCovidenceExportArticleChunkSize = 500
const comparisonProjectCovidenceExportRisContentType = 'application/x-research-info-systems; charset=utf-8'

const getComparisonProjectCovidenceExportRowChunks = (
  rows: readonly ComparisonProjectExportRow[],
): ComparisonProjectExportRow[][] => {
  return rows.length <= comparisonProjectCovidenceExportArticleChunkSize
    ? [[...rows]]
    : [
        rows.slice(0, comparisonProjectCovidenceExportArticleChunkSize),
        ...getComparisonProjectCovidenceExportRowChunks(rows.slice(comparisonProjectCovidenceExportArticleChunkSize)),
      ]
}

const getComparisonProjectCovidenceExportArticlesById = async (
  scope: ComparisonProjectScope,
  rows: readonly ComparisonProjectExportRow[],
) => {
  const articleRows = await readComparisonProjectCovidenceExportArticles({
    articleIds: rows.map((row) => {
      return row.canonicalArticleId
    }),
    database: appDatabaseService,
    scope,
  })

  return new Map<string, ComparisonProjectCovidenceExportArticle>(
    articleRows.map((articleRow) => {
      return [articleRow.articleId, getComparisonProjectCovidenceExportArticle(articleRow)]
    }),
  )
}

const getComparisonProjectCovidenceExportRisChunk = async (
  scope: ComparisonProjectScope,
  rows: readonly ComparisonProjectExportRow[],
) => {
  const articlesById = await getComparisonProjectCovidenceExportArticlesById(scope, rows)

  return rows
    .map((row) => {
      return getComparisonProjectCovidenceExportRisRecord(row, articlesById.get(row.canonicalArticleId) ?? null)
    })
    .join('')
}

const enqueueComparisonProjectCovidenceExportRows = async (
  controller: ReadableStreamDefaultController<string>,
  scope: ComparisonProjectScope,
  rows: readonly ComparisonProjectExportRow[],
) => {
  await getComparisonProjectCovidenceExportRowChunks(rows).reduce(async (previousChunk, rowChunk) => {
    await previousChunk
    controller.enqueue(await getComparisonProjectCovidenceExportRisChunk(scope, rowChunk))
  }, Promise.resolve())
}

const getComparisonProjectCovidenceExportFilename = (scope: ComparisonProjectScope) => {
  return `${scope.name.replace(/[^a-zA-Z0-9]/g, '_')}_covidence_full_text_export_${new Date().toISOString().slice(0, 10)}.ris`
}

const getComparisonProjectCovidenceExportResponseHeaders = (scope: ComparisonProjectScope) => {
  return {
    'Content-Disposition': `attachment; filename="${getComparisonProjectCovidenceExportFilename(scope)}"`,
    'Content-Type': comparisonProjectCovidenceExportRisContentType,
  }
}

export const getComparisonProjectCovidenceExportResponse = (
  scope: ComparisonProjectScope,
  selection: ComparisonProjectCovidenceExportSelection,
) => {
  const stream = new ReadableStream<string>({
    async start(controller) {
      try {
        await forEachComparisonProjectCovidenceExportRowBatch({
          onRows: (rows) => {
            return enqueueComparisonProjectCovidenceExportRows(controller, scope, rows)
          },
          scope,
          selection,
        })
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })

  return new Response(stream, {headers: getComparisonProjectCovidenceExportResponseHeaders(scope)})
}
