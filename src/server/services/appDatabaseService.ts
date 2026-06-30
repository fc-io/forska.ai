import {clearDuckdbOwnerWriteFailure, recordDuckdbOwnerWriteFailure} from '../utils/duckdbOwnerWarnings.ts'
import {
  closeDuckdbService,
  createDuckdbSnapshot,
  deleteDuckdbSnapshot,
  type DuckdbAppendRuntimeMetrics,
  type DuckdbSnapshot,
  type DuckdbWorkloadContext,
  getDuckdbAppendRuntimeMetrics,
  getDuckdbRuntimeConfig,
  runDuckdbAppendJsonQuery,
  runDuckdbBackgroundJsonQuery,
  runDuckdbBackgroundStatement,
  runDuckdbJsonQuery,
  runDuckdbMaintenance,
  runDuckdbStatement,
  runDuckdbTransaction,
} from '../utils/duckdbService.ts'

type AppDatabaseMaintenanceCommand = 'checkpoint' | 'force_checkpoint'
type AppDatabaseCloseOptions = {checkpointBeforeClose?: boolean}
type AppDatabaseSnapshot = DuckdbSnapshot
export type JudgmentInsertRow = {
  id: string
  articleId: string
  modelId: string
  promptId: string
  projectId: string | null
  isAnswered: boolean
  answeredOriginal: string | null
  answeredOriginalAsArray: string[]
  confidenceOriginal: number
  explanation: string | null
  quotes: unknown
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  chunkingStrategy: string | null
  snapshotProjectId: string | null
  snapshotProjectModelName: string | null
  createdAt: Date
  updatedAt: Date
}
export type AppendResult = {attempted: number; inserted: number; skipped: number}
export type AppDatabaseAppendMetrics = DuckdbAppendRuntimeMetrics & {
  averageRowsPerSecond: number | null
  averageRowsPerSecondAttempted: number | null
  lastInsertedRowsPerSecond: number | null
  lastInsertedRows: number | null
  lastSkippedRows: number | null
  lastStartedAt: string | null
  rowsAttempted: number
  rowsInserted: number
  rowsSkipped: number
}

const appDatabaseAppendMetricsState = {
  lastInsertedRows: null as number | null,
  lastSkippedRows: null as number | null,
  lastStartedAt: null as string | null,
  rowsAttempted: 0,
  rowsInserted: 0,
  rowsSkipped: 0,
}

const resetAppDatabaseAppendMetricsState = () => {
  appDatabaseAppendMetricsState.lastInsertedRows = null
  appDatabaseAppendMetricsState.lastSkippedRows = null
  appDatabaseAppendMetricsState.lastStartedAt = null
  appDatabaseAppendMetricsState.rowsAttempted = 0
  appDatabaseAppendMetricsState.rowsInserted = 0
  appDatabaseAppendMetricsState.rowsSkipped = 0
}

const withDuckdbOwnerWriteTracking = async <_T>(action: string, operation: () => Promise<_T>): Promise<_T> => {
  try {
    const result = await operation()
    clearDuckdbOwnerWriteFailure()
    return result
  } catch (error) {
    recordDuckdbOwnerWriteFailure({action, error})
    throw error
  }
}

const getAppendJudgmentJsonParameter = (value: unknown) => {
  return value === undefined ? null : JSON.stringify(value)
}

const getAppendJudgmentRowPlaceholders = () => {
  return `(
    ?, ?, ?, ?,
    ?, ?, ?, (?::JSON)::VARCHAR[],
    ?, ?, ?::JSON,
    ?, ?, ?, ?,
    ?, ?, ?,
    ?::TIMESTAMPTZ, ?::TIMESTAMPTZ
  )`
}

const getAppendJudgmentParameters = (row: JudgmentInsertRow) => {
  return [
    row.id,
    row.articleId,
    row.modelId,
    row.promptId,
    row.projectId,
    row.isAnswered,
    row.answeredOriginal,
    getAppendJudgmentJsonParameter(row.answeredOriginalAsArray),
    row.confidenceOriginal,
    row.explanation,
    getAppendJudgmentJsonParameter(row.quotes),
    row.useTitle,
    row.useAbstract,
    row.useFulltext,
    row.useFulltextNoImages,
    row.chunkingStrategy,
    row.snapshotProjectId,
    row.snapshotProjectModelName,
    row.createdAt.toISOString(),
    row.updatedAt.toISOString(),
  ]
}

const getAppendJudgmentsParameters = (rows: JudgmentInsertRow[]) => {
  return rows.flatMap((row) => {
    return getAppendJudgmentParameters(row)
  })
}

const getAppendJudgmentsSql = (rows: JudgmentInsertRow[]) => {
  return `
    INSERT INTO app.judgment (
      id,
      article_id,
      model_id,
      prompt_id,
      project_id,
      is_answered,
      answered_original,
      answered_original_as_array,
      confidence_original,
      explanation,
      quotes,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      chunking_strategy,
      snapshot_project_id,
      snapshot_project_model_name,
      created_at,
      updated_at
    ) VALUES ${rows
      .map(() => {
        return getAppendJudgmentRowPlaceholders()
      })
      .join(', ')}
    ON CONFLICT(article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, delete_generation) DO NOTHING
    RETURNING id
  `
}

const getRowsPerSecond = (rows: number, durationMs: number) => {
  return durationMs <= 0 ? null : Number((rows / (durationMs / 1000)).toFixed(2))
}

const getAppDatabaseAppendMetrics = (): AppDatabaseAppendMetrics => {
  const runtimeMetrics = getDuckdbAppendRuntimeMetrics()

  return {
    ...runtimeMetrics,
    averageRowsPerSecond: getRowsPerSecond(appDatabaseAppendMetricsState.rowsInserted, runtimeMetrics.totalDurationMs),
    averageRowsPerSecondAttempted: getRowsPerSecond(
      appDatabaseAppendMetricsState.rowsAttempted,
      runtimeMetrics.totalDurationMs,
    ),
    lastInsertedRows: appDatabaseAppendMetricsState.lastInsertedRows,
    lastInsertedRowsPerSecond:
      appDatabaseAppendMetricsState.lastInsertedRows === null || runtimeMetrics.lastDurationMs === null
        ? null
        : getRowsPerSecond(appDatabaseAppendMetricsState.lastInsertedRows, runtimeMetrics.lastDurationMs),
    lastSkippedRows: appDatabaseAppendMetricsState.lastSkippedRows,
    lastStartedAt: appDatabaseAppendMetricsState.lastStartedAt,
    rowsAttempted: appDatabaseAppendMetricsState.rowsAttempted,
    rowsInserted: appDatabaseAppendMetricsState.rowsInserted,
    rowsSkipped: appDatabaseAppendMetricsState.rowsSkipped,
  }
}

const appDatabaseService = {
  appendJudgments: async (rows: JudgmentInsertRow[]): Promise<AppendResult> => {
    return rows.length === 0
      ? {attempted: 0, inserted: 0, skipped: 0}
      : withDuckdbOwnerWriteTracking('appendJudgments', async () => {
          appDatabaseAppendMetricsState.lastStartedAt = new Date().toISOString()
          const insertedRows = await runDuckdbAppendJsonQuery<{id: string}>(
            getAppendJudgmentsSql(rows),
            getAppendJudgmentsParameters(rows),
          )
          const inserted = insertedRows.length
          const skipped = rows.length - inserted

          appDatabaseAppendMetricsState.lastInsertedRows = inserted
          appDatabaseAppendMetricsState.lastSkippedRows = skipped
          appDatabaseAppendMetricsState.rowsAttempted += rows.length
          appDatabaseAppendMetricsState.rowsInserted += inserted
          appDatabaseAppendMetricsState.rowsSkipped += skipped

          return {attempted: rows.length, inserted, skipped}
        })
  },
  close: async (options: AppDatabaseCloseOptions = {}) => {
    await closeDuckdbService(options)
    resetAppDatabaseAppendMetricsState()
  },
  closeForReset: async () => {
    await closeDuckdbService({releaseOwnerLease: false})
    resetAppDatabaseAppendMetricsState()
  },
  createSnapshot: async () => {
    return withDuckdbOwnerWriteTracking('createSnapshot', createDuckdbSnapshot)
  },
  deleteSnapshot: deleteDuckdbSnapshot,
  getAppendMetrics: getAppDatabaseAppendMetrics,
  getRuntimeConfig: getDuckdbRuntimeConfig,
  maintenance: async (command: AppDatabaseMaintenanceCommand, workloadContext?: DuckdbWorkloadContext) => {
    await withDuckdbOwnerWriteTracking(`maintenance:${command}`, () => {
      return runDuckdbMaintenance(command, workloadContext)
    })
  },
  queryJson: runDuckdbJsonQuery,
  queryJsonBackground: runDuckdbBackgroundJsonQuery,
  run: async (statement: string, workloadContext?: DuckdbWorkloadContext) => {
    await withDuckdbOwnerWriteTracking('run', () => {
      return runDuckdbStatement(statement, workloadContext)
    })
  },
  runBackground: async (statement: string, workloadContext?: DuckdbWorkloadContext) => {
    await withDuckdbOwnerWriteTracking('runBackground', () => {
      return runDuckdbBackgroundStatement(statement, workloadContext)
    })
  },
  transaction: async (
    operation: Parameters<typeof runDuckdbTransaction>[0],
    workloadContext?: DuckdbWorkloadContext,
  ) => {
    return withDuckdbOwnerWriteTracking('transaction', () => {
      return runDuckdbTransaction(operation, workloadContext)
    })
  },
}

export const getAppDatabaseService = () => {
  return appDatabaseService
}

export type {AppDatabaseSnapshot}
