import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../src/server/services/appQueryHelpers.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

type FailedRequestDetailsRow = {id: string; failedRequestsDetailsJson: unknown}
type FailedRequestDetailsPatch = {id: string; failedRequestsDetails: unknown[]}
type FailedRequestDetailsEntryAnalysis = {
  normalizedValue: unknown
  normalizedLegacyString: boolean
  unsupportedLegacyString: boolean
}
type FailedRequestDetailsRowAnalysis = {
  id: string
  legacyStringCount: number
  unsupportedLegacyStringCount: number
  patch: FailedRequestDetailsPatch | null
}
type TransactionRunner = {run: (statement: string) => Promise<void>}

const updateBatchSize = 200

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getFailedRequestDetailsRows = async (): Promise<FailedRequestDetailsRow[]> => {
  return getAppDatabaseService().queryJson<FailedRequestDetailsRow>(`
    SELECT
      id,
      TO_JSON(failed_requests_details) AS failedRequestsDetailsJson
    FROM app.token_use
    WHERE has_failed_requests = TRUE
      AND failed_requests_details IS NOT NULL
    ORDER BY created_at DESC
  `)
}

const getFailedRequestDetailsArray = (value: unknown) => {
  const parsedValue = getJsonValue(value)

  return Array.isArray(parsedValue) ? (parsedValue as unknown[]) : null
}

const getFailedRequestDetailsEntryAnalysis = (value: unknown): FailedRequestDetailsEntryAnalysis => {
  const parsedValue = typeof value === 'string' ? getJsonValue(value) : value
  const normalizedLegacyString = typeof value === 'string' && isRecord(parsedValue)
  const unsupportedLegacyString = typeof value === 'string' && !normalizedLegacyString

  return {
    normalizedValue: normalizedLegacyString ? parsedValue : value,
    normalizedLegacyString,
    unsupportedLegacyString,
  }
}

const getFailedRequestDetailsRowAnalysis = (row: FailedRequestDetailsRow): FailedRequestDetailsRowAnalysis => {
  const failedRequestsDetails = getFailedRequestDetailsArray(row.failedRequestsDetailsJson)
  const entryAnalyses = failedRequestsDetails
    ? failedRequestsDetails.map((entry) => {
        return getFailedRequestDetailsEntryAnalysis(entry)
      })
    : []
  const legacyStringCount = entryAnalyses.filter((entry) => {
    return entry.normalizedLegacyString
  }).length
  const unsupportedLegacyStringCount = entryAnalyses.filter((entry) => {
    return entry.unsupportedLegacyString
  }).length
  const normalizedDetails = entryAnalyses.map((entry) => {
    return entry.normalizedValue
  })
  const patch =
    failedRequestsDetails && legacyStringCount > 0 && unsupportedLegacyStringCount === 0
      ? {id: row.id, failedRequestsDetails: normalizedDetails}
      : null

  return {id: row.id, legacyStringCount, unsupportedLegacyStringCount, patch}
}

const getJsonLiteral = (value: unknown) => {
  return value === null || value === undefined ? 'NULL' : `json(${getSqlLiteral(JSON.stringify(value))})`
}

const getUpdateChunks = <T>(values: T[], chunkSize: number): T[][] => {
  const currentChunk = values.slice(0, chunkSize)

  return currentChunk.length === 0 ? [] : [currentChunk, ...getUpdateChunks(values.slice(chunkSize), chunkSize)]
}

const getBackfillUpdateSql = (updates: FailedRequestDetailsPatch[]) => {
  return `
    UPDATE app.token_use AS token_use
    SET failed_requests_details = patch_rows.failed_requests_details
    FROM (
      VALUES ${updates
        .map((update) => {
          return `(${getSqlLiteral(update.id)}, ${getJsonLiteral(update.failedRequestsDetails)})`
        })
        .join(', ')}
    ) AS patch_rows(id, failed_requests_details)
    WHERE token_use.id = patch_rows.id;
  `
}

const applyUpdateChunks = async (
  tx: TransactionRunner,
  chunks: FailedRequestDetailsPatch[][],
  index = 0,
): Promise<void> => {
  const currentChunk = chunks[index]

  if (!currentChunk) {
    return
  }

  await tx.run(getBackfillUpdateSql(currentChunk))
  return applyUpdateChunks(tx, chunks, index + 1)
}

const getBackfillSummary = (rowAnalyses: FailedRequestDetailsRowAnalysis[]) => {
  const patches = rowAnalyses.reduce<FailedRequestDetailsPatch[]>((acc, rowAnalysis) => {
    return rowAnalysis.patch ? [...acc, rowAnalysis.patch] : acc
  }, [])
  const invalidRowIds = rowAnalyses.reduce<string[]>((acc, rowAnalysis) => {
    return rowAnalysis.unsupportedLegacyStringCount > 0 ? [...acc, rowAnalysis.id] : acc
  }, [])

  return {
    invalidRowIds,
    malformedRowIds: patches.map((patch) => {
      return patch.id
    }),
    patches,
    scannedRowCount: rowAnalyses.length,
  }
}

const runBackfillFailedRequestDetails = async () => {
  await withDuckdbMaintenanceAccess('backfill failed request details', async () => {
    const beforeRowAnalyses = (await getFailedRequestDetailsRows()).map((row) => {
      return getFailedRequestDetailsRowAnalysis(row)
    })
    const beforeSummary = getBackfillSummary(beforeRowAnalyses)

    console.log(
      JSON.stringify(
        {
          invalidRowIds: beforeSummary.invalidRowIds,
          malformedRowIds: beforeSummary.malformedRowIds,
          malformedRowsBefore: beforeSummary.patches.length,
          scannedRows: beforeSummary.scannedRowCount,
        },
        null,
        2,
      ),
    )

    if (beforeSummary.patches.length === 0) {
      return
    }

    await getAppDatabaseService().transaction(async (tx) => {
      return applyUpdateChunks(tx, getUpdateChunks(beforeSummary.patches, updateBatchSize))
    })
    await getAppDatabaseService().maintenance('checkpoint')

    const afterSummary = getBackfillSummary(
      (await getFailedRequestDetailsRows()).map((row) => {
        return getFailedRequestDetailsRowAnalysis(row)
      }),
    )

    console.log(
      JSON.stringify(
        {
          invalidRowIds: afterSummary.invalidRowIds,
          malformedRowIds: afterSummary.malformedRowIds,
          malformedRowsAfter: afterSummary.patches.length,
          scannedRows: afterSummary.scannedRowCount,
          updatedRowIds: beforeSummary.malformedRowIds,
        },
        null,
        2,
      ),
    )

    if (afterSummary.patches.length > 0) {
      throw new Error(`Failed request detail backfill left ${afterSummary.patches.length} malformed rows`)
    }
  })
}

if (import.meta.main) {
  await runBackfillFailedRequestDetails()
}

export {getFailedRequestDetailsRowAnalysis}
