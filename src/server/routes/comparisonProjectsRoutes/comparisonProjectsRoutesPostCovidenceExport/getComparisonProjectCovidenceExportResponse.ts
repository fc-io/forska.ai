import type {ComparisonProjectCovidenceExportSelection} from '../../../../utils/comparisonProjectCovidenceExportSelection.ts'
import {
  covidenceImportMaxReferencesPerFile,
  type CovidenceImportPartSegment,
  getCovidenceImportPartCount,
  getCovidenceImportPartSegments,
} from '../../../../utils/covidenceImportLimits.ts'
import {readComparisonProjectCovidenceExportArticles} from '../../../services/comparisonProjectCovidenceExportArticleRepository.ts'
import {appDatabaseService} from '../comparisonProjectRouteServices.ts'
import type {ComparisonProjectScope} from '../comparisonProjectScopeTypes.ts'
import type {ComparisonProjectExportRow} from '../comparisonProjectsRoutesPostExport/comparisonProjectExportRow.ts'
import {
  type ComparisonProjectCovidenceExportArticle,
  getComparisonProjectCovidenceExportArticle,
} from './comparisonProjectCovidenceExportArticle.ts'
import {getComparisonProjectCovidenceExportFilenameStem} from './comparisonProjectCovidenceExportFilename.ts'
import {
  type ComparisonProjectCovidenceExportPartWriter,
  type ComparisonProjectCovidenceExportPlan,
  getComparisonProjectCovidenceExportRisWriter,
  getComparisonProjectCovidenceExportZipWriter,
} from './comparisonProjectCovidenceExportPartWriter.ts'
import {getComparisonProjectCovidenceExportRisRecord} from './comparisonProjectCovidenceExportRisRecord.ts'
import {forEachComparisonProjectCovidenceExportRowBatch} from './forEachComparisonProjectCovidenceExportRowBatch.ts'
import {getComparisonProjectCovidenceExportCount} from './getComparisonProjectCovidenceExportCount.ts'

const comparisonProjectCovidenceExportArticleChunkSize = 500
const comparisonProjectCovidenceExportRisContentType = 'application/x-research-info-systems; charset=utf-8'
const comparisonProjectCovidenceExportZipContentType = 'application/zip'

const comparisonProjectCovidenceExportSelectionChangedError =
  'The Covidence export selection changed while the export was written; export again'

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

const writeComparisonProjectCovidenceExportSegment = async (
  writer: ComparisonProjectCovidenceExportPartWriter,
  scope: ComparisonProjectScope,
  segment: CovidenceImportPartSegment<ComparisonProjectExportRow>,
) => {
  await getComparisonProjectCovidenceExportRowChunks(segment.records).reduce(async (previousChunk, rowChunk) => {
    await previousChunk
    writer.write(segment.partIndex, await getComparisonProjectCovidenceExportRisChunk(scope, rowChunk))
  }, Promise.resolve())
}

const checkComparisonProjectCovidenceExportPartCount = (
  plan: ComparisonProjectCovidenceExportPlan,
  recordCount: number,
  isComplete: boolean,
) => {
  const partCount = getCovidenceImportPartCount(recordCount, plan.maxRecordsPerFile)

  if (partCount > plan.partCount || (isComplete && partCount < plan.partCount)) {
    throw new Error(comparisonProjectCovidenceExportSelectionChangedError)
  }
}

const writeComparisonProjectCovidenceExportRows = async (
  writer: ComparisonProjectCovidenceExportPartWriter,
  scope: ComparisonProjectScope,
  plan: ComparisonProjectCovidenceExportPlan,
  writeState: {recordCount: number},
  rows: readonly ComparisonProjectExportRow[],
) => {
  const segments = getCovidenceImportPartSegments(rows, writeState.recordCount, plan.maxRecordsPerFile)

  writeState.recordCount += rows.length
  checkComparisonProjectCovidenceExportPartCount(plan, writeState.recordCount, false)
  await segments.reduce(async (previousSegment, segment) => {
    await previousSegment
    await writeComparisonProjectCovidenceExportSegment(writer, scope, segment)
  }, Promise.resolve())
}

const writeComparisonProjectCovidenceExport = async (
  writer: ComparisonProjectCovidenceExportPartWriter,
  scope: ComparisonProjectScope,
  selection: ComparisonProjectCovidenceExportSelection,
  plan: ComparisonProjectCovidenceExportPlan,
) => {
  const writeState = {recordCount: 0}

  await forEachComparisonProjectCovidenceExportRowBatch({
    onRows: (rows) => {
      return writeComparisonProjectCovidenceExportRows(writer, scope, plan, writeState, rows)
    },
    scope,
    selection,
  })
  checkComparisonProjectCovidenceExportPartCount(plan, writeState.recordCount, true)
  writer.close()
}

const getComparisonProjectCovidenceExportStream = <TChunk extends string | Uint8Array>(
  getWriter: (controller: ReadableStreamDefaultController<TChunk>) => ComparisonProjectCovidenceExportPartWriter,
  scope: ComparisonProjectScope,
  selection: ComparisonProjectCovidenceExportSelection,
  plan: ComparisonProjectCovidenceExportPlan,
) => {
  return new ReadableStream<TChunk>({
    async start(controller) {
      try {
        await writeComparisonProjectCovidenceExport(getWriter(controller), scope, selection, plan)
      } catch (error) {
        controller.error(error)
      }
    },
  })
}

const getComparisonProjectCovidenceExportRisResponse = (
  scope: ComparisonProjectScope,
  selection: ComparisonProjectCovidenceExportSelection,
  plan: ComparisonProjectCovidenceExportPlan,
) => {
  return new Response(
    getComparisonProjectCovidenceExportStream(getComparisonProjectCovidenceExportRisWriter, scope, selection, plan),
    {
      headers: {
        'Content-Disposition': `attachment; filename="${plan.filenameStem}.ris"`,
        'Content-Type': comparisonProjectCovidenceExportRisContentType,
      },
    },
  )
}

const getComparisonProjectCovidenceExportZipResponse = (
  scope: ComparisonProjectScope,
  selection: ComparisonProjectCovidenceExportSelection,
  plan: ComparisonProjectCovidenceExportPlan,
) => {
  return new Response(
    getComparisonProjectCovidenceExportStream<Uint8Array>(
      (controller) => {
        return getComparisonProjectCovidenceExportZipWriter(controller, plan)
      },
      scope,
      selection,
      plan,
    ),
    {
      headers: {
        'Content-Disposition': `attachment; filename="${plan.filenameStem}.zip"`,
        'Content-Type': comparisonProjectCovidenceExportZipContentType,
      },
    },
  )
}

export const getComparisonProjectCovidenceExportResponse = async (
  scope: ComparisonProjectScope,
  selection: ComparisonProjectCovidenceExportSelection,
  maxRecordsPerFile = covidenceImportMaxReferencesPerFile,
) => {
  const {totalCount} = await getComparisonProjectCovidenceExportCount(scope, selection)
  const plan: ComparisonProjectCovidenceExportPlan = {
    filenameStem: getComparisonProjectCovidenceExportFilenameStem(scope),
    maxRecordsPerFile,
    partCount: getCovidenceImportPartCount(totalCount, maxRecordsPerFile),
  }

  return plan.partCount > 1
    ? getComparisonProjectCovidenceExportZipResponse(scope, selection, plan)
    : getComparisonProjectCovidenceExportRisResponse(scope, selection, plan)
}
