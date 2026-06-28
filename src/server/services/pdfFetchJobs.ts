import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {type ArticleSourceMetadata, getArticleSourceMetadataValue} from '../../utils/articleSourceMetadata.ts'
import {fetchPdfForArticle} from '../cron/fullTextJobs/fetchPdfForArticle.ts'
import {
  appendArticleReviewServingDeltas,
  getArticleReviewServingMutationValueHash,
} from '../reviewServing/articleReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {
  escapeSqlString,
  getDateValue,
  getJsonValue,
  getQuotedStringList,
  getSqlLiteral,
  getTimestampLiteral,
} from '../services/appQueryHelpers.ts'

type PdfFetchJobStatus = 'queued' | 'running' | 'completed' | 'failed'

export type PdfFetchJob = {
  jobId: string
  status: PdfFetchJobStatus
  createdAtMs: number
  startedAtMs: number | null
  finishedAtMs: number | null
  concurrency: number
  forceRefetch: boolean
  total: number
  processed: number
  attempted: number
  succeeded: number
  noPdf: number
  skipped: number
  failed: number
  lastError: string | null
}

export type PdfFetchBatchStats = {attempted: number; failed: number; noPdf: number; skipped: number; succeeded: number}

type DurablePdfFetchJobRow = {
  batchSize: number
  cancelRequested: boolean
  completedAt: string | null
  createdAt: string
  criteriaJson: unknown
  cursorJson: unknown
  jobId: string
  lastError: string | null
  processedCount: number
  resultManifestJson: unknown
  status: string
  totalEstimate: number | null
  updatedAt: string
}

const DEFAULT_CONCURRENCY = 5
const pdfFetchWorkloadContext = {
  fallbackIntent: 'reject' as const,
  routeOrJobKey: 'review.pdf.selection',
  workloadClass: 'background.review.pdfFetch',
}

const normalizeArticleIds = (articleIds: string[]): string[] => {
  const trimmed = articleIds
    .map((id) => {
      return String(id).trim()
    })
    .filter(Boolean)

  return [...new Set(trimmed)]
}

const shouldSkipRow = (row: Pick<ArticleRecord, 'fullTextPDF' | 'fullTextSource'>, forceRefetch: boolean): boolean => {
  const hasUploadedPdf = row.fullTextSource === 'user_upload'
  const hasPdf = Boolean(row.fullTextPDF)
  return !forceRefetch && (hasUploadedPdf || hasPdf)
}

const buildUpdateForAttempt = (result: Awaited<ReturnType<typeof fetchPdfForArticle>> | null) => {
  const base = {fullTextFetchedAt: new Date()}
  return result?.fullTextPDF
    ? {
        ...base,
        fullTextPDF: result.fullTextPDF,
        fullTextSource: result.fullTextSource,
        fullTextOriginalFormat: result.fullTextOriginalFormat,
        fullTextConversionStatus: null,
        fullTextConversionAttempts: 0,
        fullTextConversionError: null,
        fullText: null,
        fullTextHtml: null,
      }
    : base
}

const splitFirstChunk = <T>(items: T[], chunkSize: number): {chunk: T[]; rest: T[]} => {
  const size = chunkSize > 0 ? chunkSize : DEFAULT_CONCURRENCY
  const chunk = items.slice(0, size)
  const rest = items.slice(size)
  return {chunk, rest}
}

type PdfFetchRow = Pick<ArticleRecord, 'id' | 'arxivId' | 'doi'> & {sourceMetadata: ArticleSourceMetadata | null}

const emptyPdfFetchBatchStats = (): PdfFetchBatchStats => {
  return {attempted: 0, failed: 0, noPdf: 0, skipped: 0, succeeded: 0}
}

const fetchAndStoreForRow = async (row: PdfFetchRow) => {
  const result = await fetchPdfForArticle({
    arxivId: row.arxivId,
    doi: row.doi,
    sourceMetadata: row.sourceMetadata,
  }).catch((error) => {
    return Promise.reject(error)
  })

  const update = buildUpdateForAttempt(result)
  const updateParts = Object.entries(update).map(([key, value]) => {
    const columnNameMap: Record<string, string> = {
      fullTextFetchedAt: 'full_text_fetched_at',
      fullTextPDF: 'full_text_pdf',
      fullTextSource: 'full_text_source',
      fullTextOriginalFormat: 'full_text_original_format',
      fullTextConversionStatus: 'full_text_conversion_status',
      fullTextConversionAttempts: 'full_text_conversion_attempts',
      fullTextConversionError: 'full_text_conversion_error',
      fullText: 'full_text',
      fullTextHtml: 'full_text_html',
    }
    return `${columnNameMap[key] ?? key} = ${getSqlLiteral(value)}`
  })
  await getAppDatabaseService().transaction(async (tx) => {
    const updatedAt = new Date()
    await tx.run(`
      UPDATE app.article
      SET ${updateParts.join(', ')},
          updated_at = ${getTimestampLiteral(updatedAt)}
      WHERE id = '${escapeSqlString(row.id)}'
    `)
    await appendArticleReviewServingDeltas(tx, {
      articleId: row.id,
      changedFields: result?.fullTextPDF ? ['fullText', 'fullTextHtml', 'fullTextPDF'] : [],
      sourceMutationKey: `pdfFetchJobs|article|${row.id}|${updatedAt.toISOString()}|${getArticleReviewServingMutationValueHash(result)}`,
      sourceOperation: 'update',
      sourceUpdatedAt: updatedAt,
    })
  }, pdfFetchWorkloadContext)
  return result
}

const fetchAndStorePdfForRowSafe = async (row: PdfFetchRow): Promise<PdfFetchBatchStats> => {
  return fetchAndStoreForRow(row)
    .then((result) => {
      return {
        ...emptyPdfFetchBatchStats(),
        attempted: 1,
        noPdf: result?.fullTextPDF ? 0 : 1,
        succeeded: result?.fullTextPDF ? 1 : 0,
      }
    })
    .catch(async () => {
      const update = buildUpdateForAttempt(null)
      const updateParts = Object.entries(update).map(([key, value]) => {
        const columnNameMap: Record<string, string> = {
          fullTextFetchedAt: 'full_text_fetched_at',
          fullTextPDF: 'full_text_pdf',
          fullTextSource: 'full_text_source',
          fullTextOriginalFormat: 'full_text_original_format',
        }
        return `${columnNameMap[key] ?? key} = ${getSqlLiteral(value)}`
      })
      await getAppDatabaseService().runBackground(
        `
        UPDATE app.article
        SET ${updateParts.join(', ')},
            updated_at = ${getTimestampLiteral(new Date())}
        WHERE id = '${escapeSqlString(row.id)}'
      `,
        pdfFetchWorkloadContext,
      )
      return {...emptyPdfFetchBatchStats(), attempted: 1, failed: 1}
    })
}

const sumPdfFetchBatchStats = (stats: readonly PdfFetchBatchStats[]): PdfFetchBatchStats => {
  return stats.reduce((acc, stat) => {
    return {
      attempted: acc.attempted + stat.attempted,
      failed: acc.failed + stat.failed,
      noPdf: acc.noPdf + stat.noPdf,
      skipped: acc.skipped + stat.skipped,
      succeeded: acc.succeeded + stat.succeeded,
    }
  }, emptyPdfFetchBatchStats())
}

const processRowsWithConcurrency = async (
  rows: readonly PdfFetchRow[],
  concurrency: number,
): Promise<PdfFetchBatchStats> => {
  const {chunk, rest} = splitFirstChunk([...rows], concurrency)
  const stats = await Promise.all(
    chunk.map((row) => {
      return fetchAndStorePdfForRowSafe(row)
    }),
  )

  return rest.length === 0
    ? sumPdfFetchBatchStats(stats)
    : processRowsWithConcurrency(rest, concurrency).then((restStats) => {
        return sumPdfFetchBatchStats([...stats, restStats])
      })
}

export const processPdfFetchArticleIds = async (args: {
  articleIds: readonly string[]
  concurrency?: number
  forceRefetch?: boolean
}): Promise<PdfFetchBatchStats> => {
  const ids = normalizeArticleIds([...args.articleIds])
  if (ids.length === 0) {
    return emptyPdfFetchBatchStats()
  }

  const rows = await getAppDatabaseService().queryJsonBackground<{
    id: string
    arxivId: string | null
    doi: string | null
    sourceMetadata: unknown
    fullTextPDF: string | null
    fullTextSource: string | null
  }>(
    `
    SELECT
      id,
      arxiv_id AS arxivId,
      doi,
      TO_JSON(source_metadata) AS sourceMetadata,
      full_text_pdf AS fullTextPDF,
      full_text_source AS fullTextSource
    FROM app.article
    WHERE id IN (${getQuotedStringList(ids).join(', ')})
  `,
    {...pdfFetchWorkloadContext, maxResultRows: ids.length},
  )
  const normalizedRows = rows.map((row) => {
    return {...row, sourceMetadata: getArticleSourceMetadataValue(row.sourceMetadata)}
  })
  const foundIds = new Set(
    normalizedRows.map((row) => {
      return row.id
    }),
  )
  const missingCount = ids.reduce((acc, id) => {
    return acc + (foundIds.has(id) ? 0 : 1)
  }, 0)
  const rowsToAttempt = normalizedRows.filter((row) => {
    return !shouldSkipRow(row, Boolean(args.forceRefetch))
  })
  const skippedCount = rows.length - rowsToAttempt.length
  const stats = await processRowsWithConcurrency(rowsToAttempt, args.concurrency ?? DEFAULT_CONCURRENCY)

  return {...stats, failed: stats.failed + missingCount, skipped: stats.skipped + skippedCount}
}

const getDurablePdfFetchJobStatus = (row: DurablePdfFetchJobRow): PdfFetchJobStatus => {
  return row.status === 'completed'
    ? 'completed'
    : row.status === 'failed' || row.status === 'cancelled'
      ? 'failed'
      : row.status === 'running'
        ? 'running'
        : 'queued'
}

const getDurablePdfFetchCriteria = (row: DurablePdfFetchJobRow) => {
  const value = getJsonValue(row.criteriaJson)

  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as {concurrency?: number; forceRefetch?: boolean})
    : {}
}

const getDurablePdfFetchResultManifest = (row: DurablePdfFetchJobRow) => {
  const value = getJsonValue(row.resultManifestJson)

  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as {attempted?: number; failed?: number; noPdf?: number; skipped?: number; succeeded?: number})
    : {}
}

export const getPdfFetchJobFromDatabase = async (
  jobId: string,
  database: Pick<ReturnType<typeof getAppDatabaseService>, 'queryJson'> = getAppDatabaseService(),
): Promise<PdfFetchJob | null> => {
  const [row] = await database.queryJson<DurablePdfFetchJobRow>(`
    SELECT
      job_id AS jobId,
      criteria_json AS criteriaJson,
      cursor_json AS cursorJson,
      batch_size AS batchSize,
      status,
      result_manifest_json AS resultManifestJson,
      processed_count AS processedCount,
      total_estimate AS totalEstimate,
      updated_at AS updatedAt,
      cancel_requested AS cancelRequested,
      last_error AS lastError,
      created_at AS createdAt,
      completed_at AS completedAt
    FROM app.review_bulk_operation_job
    WHERE job_id = ${getSqlLiteral(jobId)}
      AND job_kind = 'review.pdf.selection'
    LIMIT 1
  `)

  if (!row) {
    return null
  }

  const criteria = getDurablePdfFetchCriteria(row)
  const manifest = getDurablePdfFetchResultManifest(row)
  const createdAtMs = getDateValue(row.createdAt)?.getTime() ?? Date.now()
  const finishedAtMs = row.completedAt ? (getDateValue(row.completedAt)?.getTime() ?? null) : null
  const status = getDurablePdfFetchJobStatus(row)
  const processed = Number(row.processedCount)

  return {
    attempted: Number(manifest.attempted ?? processed),
    concurrency: Number(criteria.concurrency ?? row.batchSize),
    createdAtMs,
    failed: Number(manifest.failed ?? (status === 'failed' ? 1 : 0)),
    finishedAtMs,
    forceRefetch: Boolean(criteria.forceRefetch),
    jobId: row.jobId,
    lastError: row.lastError,
    noPdf: Number(manifest.noPdf ?? 0),
    processed,
    skipped: Number(manifest.skipped ?? 0),
    startedAtMs: status === 'queued' ? null : createdAtMs,
    status,
    succeeded: Number(manifest.succeeded ?? 0),
    total: Number(row.totalEstimate ?? processed),
  }
}
