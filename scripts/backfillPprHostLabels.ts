import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getSqlLiteral} from '../src/server/services/appQueryHelpers.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'
import {getArticleSourceMetadata} from '../src/utils/articleSourceMetadata.ts'
import {sleep} from '../src/utils/sleep.ts'

type PprTargetRow = {id: string; articleId: string; doi: string | null}
type PprHostLabelPatch = {preprintHostLabel: string; preprintSource: string; isPreprint: true}
type PprHostLabelUpdate = {id: string; articleId: string; patch: PprHostLabelPatch}

const europePmcCursorQuery = 'SRC:PPR'
const europePmcCursorPageSize = 1000
const europePmcFetchTimeoutMs = 20_000
const europePmcRetryDelays = [5_000, 15_000, 60_000, 300_000]
const targetedLookupBatchSize = 25
const updateBatchSize = 500
const workloadContext = getMaintenanceDuckdbWorkloadContext('backfillPprHostLabels')

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const asNonEmptyString = (value: unknown) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed === '' ? null : trimmed
}

const getTargetRows = async (): Promise<PprTargetRow[]> => {
  return getAppDatabaseService().queryJson<PprTargetRow>(
    `
    SELECT id, article_id AS articleId, doi
    FROM app.article
    WHERE lower(coalesce(json_extract_string(source_metadata, '$.preprintSource'), '')) = 'ppr'
      AND nullif(trim(coalesce(json_extract_string(source_metadata, '$.preprintHostLabel'), '')), '') IS NULL
  `,
    workloadContext,
  )
}

const getUpdateChunks = <T>(values: T[], chunkSize: number): T[][] => {
  const currentChunk = values.slice(0, chunkSize)

  return currentChunk.length === 0 ? [] : [currentChunk, ...getUpdateChunks(values.slice(chunkSize), chunkSize)]
}

const applyUpdateChunks = async (chunks: PprHostLabelUpdate[][], index = 0): Promise<void> => {
  const chunk = chunks[index]

  if (!chunk) {
    return
  }

  await getAppDatabaseService().run(
    `
    UPDATE app.article AS article
    SET source_metadata = json_merge_patch(coalesce(article.source_metadata, json('{}')), patch_rows.patch)
    FROM (
      VALUES ${chunk
        .map((update) => {
          return `(${getSqlLiteral(update.id)}, json(${getSqlLiteral(update.patch)}))`
        })
        .join(', ')}
    ) AS patch_rows(id, patch)
    WHERE article.id = patch_rows.id;
  `,
    workloadContext,
  )

  return applyUpdateChunks(chunks, index + 1)
}

const applyUpdates = async (updates: PprHostLabelUpdate[]) => {
  if (updates.length === 0) {
    return
  }

  return applyUpdateChunks(getUpdateChunks(updates, updateBatchSize))
}

const fetchWithTimeoutAndRetry = (url: URL, timeoutMs: number, retryDelays: number[]): Promise<Response> => {
  const attempt = (index: number): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    const responsePromise = fetch(url, {signal: controller.signal}).finally(() => {
      clearTimeout(timer)
    })

    return responsePromise.then(
      (response) => {
        if (response.ok) {
          return response
        }

        const retryDelay = retryDelays[index]

        return retryDelay === undefined
          ? Promise.reject(new Error(`Europe PMC HTTP ${response.status}`))
          : sleep(retryDelay).then(() => {
              return attempt(index + 1)
            })
      },
      (error) => {
        const retryDelay = retryDelays[index]

        return retryDelay === undefined
          ? Promise.reject(error)
          : sleep(retryDelay).then(() => {
              return attempt(index + 1)
            })
      },
    )
  }

  return attempt(0)
}

const getEuropePmcSearchPage = async (params: {query: string; pageSize: number; cursorMark?: string}) => {
  const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search')
  url.searchParams.set('query', params.query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('resultType', 'lite')
  url.searchParams.set('pageSize', String(params.pageSize))

  if (params.cursorMark) {
    url.searchParams.set('cursorMark', params.cursorMark)
  }

  const response = await fetchWithTimeoutAndRetry(url, europePmcFetchTimeoutMs, europePmcRetryDelays)
  const payload = (await response.json()) as unknown
  const record = isRecord(payload) ? payload : {}
  const resultList = isRecord(record.resultList) ? record.resultList : {}
  const rawItems = resultList.result
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : []
  const hitCountValue = record.hitCount
  const hitCount =
    typeof hitCountValue === 'number'
      ? hitCountValue
      : Number.parseInt(asNonEmptyString(hitCountValue) ?? `${items.length}`, 10)

  return {
    items,
    nextCursorMark: asNonEmptyString(record.nextCursorMark),
    hitCount: Number.isNaN(hitCount) ? items.length : hitCount,
  }
}

const getPprHostLabelUpdate = (item: unknown, articleIdToTargetRow: Map<string, PprTargetRow>) => {
  const record = isRecord(item) ? item : null
  const rawId = record ? asNonEmptyString(record.id) : null
  const articleId = rawId ? `ppr:${rawId}` : null
  const targetRow = articleId ? articleIdToTargetRow.get(articleId) : null
  const metadata =
    articleId && targetRow ? getArticleSourceMetadata({articleId, doi: targetRow.doi, originalData: record}) : null

  return targetRow && articleId && metadata?.preprintHostLabel && metadata.preprintSource
    ? {
        id: targetRow.id,
        articleId,
        patch: {
          preprintHostLabel: metadata.preprintHostLabel,
          preprintSource: metadata.preprintSource,
          isPreprint: true as const,
        },
      }
    : null
}

const getPprHostLabelFallbackUpdate = (targetRow: PprTargetRow | undefined) => {
  const metadata = targetRow ? getArticleSourceMetadata({articleId: targetRow.articleId, doi: targetRow.doi}) : null

  return targetRow && metadata?.preprintHostLabel && metadata.preprintSource
    ? {
        id: targetRow.id,
        articleId: targetRow.articleId,
        patch: {
          preprintHostLabel: metadata.preprintHostLabel,
          preprintSource: metadata.preprintSource,
          isPreprint: true as const,
        },
      }
    : null
}

const getExternalPprId = (articleId: string) => {
  return articleId.startsWith('ppr:') ? articleId.slice('ppr:'.length) : articleId
}

const getTargetedPprQuery = (articleId: string) => {
  return `SRC:PPR AND (EXT_ID:${getExternalPprId(articleId)})`
}

const removeUpdatedArticleIds = (articleIdToTargetRow: Map<string, PprTargetRow>, articleIds: string[]) => {
  articleIds.reduce((map, articleId) => {
    map.delete(articleId)
    return map
  }, articleIdToTargetRow)
}

const logBackfillProgress = (params: {
  pageNumber: number
  scannedCount: number
  matchedCount: number
  updatedCount: number
  hitCount: number
  remainingCount: number
}) => {
  const isMilestonePage = params.pageNumber % 25 === 0
  const hasMatches = params.matchedCount > 0
  const isDone = params.remainingCount === 0 || params.scannedCount >= params.hitCount

  if (isMilestonePage || hasMatches || isDone || params.pageNumber === 1) {
    console.log(
      `[backfillPprHostLabels] page ${params.pageNumber}, scanned ${params.scannedCount}/${params.hitCount}, matched ${params.matchedCount}, updated ${params.updatedCount}, remaining ${params.remainingCount}`,
    )
  }
}

const backfillFromEuropePmc = async (params: {
  articleIdToTargetRow: Map<string, PprTargetRow>
  cursorMark?: string
  pageNumber?: number
  scannedCount?: number
  updatedCount?: number
}): Promise<{scannedCount: number; updatedCount: number; remainingCount: number}> => {
  if (params.articleIdToTargetRow.size === 0) {
    return {scannedCount: params.scannedCount ?? 0, updatedCount: params.updatedCount ?? 0, remainingCount: 0}
  }

  const pageNumber = params.pageNumber ?? 1
  const scannedCount = params.scannedCount ?? 0
  const updatedCount = params.updatedCount ?? 0
  const page = await getEuropePmcSearchPage({
    query: europePmcCursorQuery,
    pageSize: europePmcCursorPageSize,
    cursorMark: params.cursorMark,
  })
  const updates = page.items
    .map((item) => {
      return getPprHostLabelUpdate(item, params.articleIdToTargetRow)
    })
    .filter((update): update is PprHostLabelUpdate => {
      return update !== null
    })

  await applyUpdates(updates)
  removeUpdatedArticleIds(
    params.articleIdToTargetRow,
    updates.map((update) => {
      return update.articleId
    }),
  )

  const nextScannedCount = scannedCount + page.items.length
  const nextUpdatedCount = updatedCount + updates.length

  logBackfillProgress({
    pageNumber,
    scannedCount: nextScannedCount,
    matchedCount: updates.length,
    updatedCount: nextUpdatedCount,
    hitCount: page.hitCount,
    remainingCount: params.articleIdToTargetRow.size,
  })

  return !page.nextCursorMark || page.nextCursorMark === params.cursorMark || params.articleIdToTargetRow.size === 0
    ? {scannedCount: nextScannedCount, updatedCount: nextUpdatedCount, remainingCount: params.articleIdToTargetRow.size}
    : backfillFromEuropePmc({
        articleIdToTargetRow: params.articleIdToTargetRow,
        cursorMark: page.nextCursorMark,
        pageNumber: pageNumber + 1,
        scannedCount: nextScannedCount,
        updatedCount: nextUpdatedCount,
      })
}

const backfillRemainingArticleIds = async (
  articleIdToTargetRow: Map<string, PprTargetRow>,
  articleIds: string[],
  index = 0,
  updatedCount = 0,
): Promise<number> => {
  const articleId = articleIds[index]

  if (!articleId) {
    return updatedCount
  }

  const page = await getEuropePmcSearchPage({query: getTargetedPprQuery(articleId), pageSize: 1})
  const pageUpdates = page.items
    .map((item) => {
      return getPprHostLabelUpdate(item, articleIdToTargetRow)
    })
    .filter((update): update is PprHostLabelUpdate => {
      return update !== null
    })
  const fallbackUpdate =
    pageUpdates.length === 0 ? getPprHostLabelFallbackUpdate(articleIdToTargetRow.get(articleId)) : null
  const updates = fallbackUpdate ? [fallbackUpdate] : pageUpdates

  await applyUpdates(updates)
  removeUpdatedArticleIds(
    articleIdToTargetRow,
    updates.map((update) => {
      return update.articleId
    }),
  )

  const nextUpdatedCount = updatedCount + updates.length
  const isMilestoneItem = (index + 1) % targetedLookupBatchSize === 0
  const isDone = index === articleIds.length - 1

  if (isMilestoneItem || updates.length > 0 || isDone) {
    console.log(
      `[backfillPprHostLabels] targeted item ${index + 1}/${articleIds.length}, matched ${updates.length}, updated ${nextUpdatedCount}, remaining ${articleIdToTargetRow.size}`,
    )
  }

  return backfillRemainingArticleIds(articleIdToTargetRow, articleIds, index + 1, nextUpdatedCount)
}

const runBackfillPprHostLabels = async () => {
  await withDuckdbMaintenanceAccess('backfill ppr host labels', async () => {
    const targetRows = await getTargetRows()

    if (targetRows.length === 0) {
      console.log('[backfillPprHostLabels] no PPR rows need host-label backfill')
      return
    }

    console.log(`[backfillPprHostLabels] rows before backfill: ${targetRows.length}`)
    const articleIdToTargetRow = new Map(
      targetRows.map((row) => {
        return [row.articleId, row]
      }),
    )
    const shouldUseCursorScan = targetRows.length > europePmcCursorPageSize

    if (!shouldUseCursorScan) {
      console.log(`[backfillPprHostLabels] skipping full cursor scan for ${targetRows.length} targeted rows`)
    }

    const cursorResult = shouldUseCursorScan
      ? await backfillFromEuropePmc({articleIdToTargetRow})
      : {scannedCount: 0, updatedCount: 0, remainingCount: articleIdToTargetRow.size}
    const targetedUpdatedCount = await backfillRemainingArticleIds(
      articleIdToTargetRow,
      Array.from(articleIdToTargetRow.keys()),
    )
    await getAppDatabaseService().maintenance('checkpoint', workloadContext)
    console.log(
      `[backfillPprHostLabels] done. scanned ${cursorResult.scannedCount}, updated ${cursorResult.updatedCount + targetedUpdatedCount}, remaining ${articleIdToTargetRow.size}`,
    )
  })
}

if (import.meta.main) {
  await runBackfillPprHostLabels()
}
