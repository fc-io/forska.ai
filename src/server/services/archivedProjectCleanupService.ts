import {getAppDatabaseService} from './appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from './appQueryHelpers.ts'

type AppRunner = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}
type CleanupPhase =
  | 'final_delete'
  | 'idle'
  | 'mart_cleanup'
  | 'runtime_state_cleanup'
  | 'source_cleanup'
  | 'tombstone_cleanup'
type CleanupMutation = {
  optional?: boolean
  phase: CleanupPhase
  setSql?: string
  tableName: string
  whereSql: (projectId: string) => string
}
type ProjectArchivedStateRow = {deletePendingAt: unknown; id: string; archived: boolean}
type ProjectForeignKeyInventoryRow = {columnName: string; schemaName: string; tableName: string}
type RemainingProjectReferenceRow = {columnName: string; rowCount: number; tableName: string}
type RowIdRow = {rowId: bigint | number | string}

export type ArchivedProjectCleanupBatchResult = {
  deletedRowCount: number
  phase: CleanupPhase
  projectId: string | null
  tableName: string | null
}

export type ArchivedProjectDeletePendingResult = {projectIds: string[]}
export type ArchivedProjectCleanupRunResult = {
  batches: ArchivedProjectCleanupBatchResult[]
  deletedRowCount: number
  status: 'completed' | 'stopped'
}

const defaultCleanupBatchSize = 1000
const defaultMaxCleanupBatches = 100
const terminalJudgmentJobStatuses = ['completed', 'failed', 'project_removed']

const archivedProjectMartCleanupMutations: CleanupMutation[] = [
  'mart.review_article_serving_detail',
  'mart.review_article_filter_member',
  'mart.review_article_serving',
  'mart.review_article_rollup',
  'mart.prompt_answer_fact',
  'mart.project_scope_article',
  'app.project_review_serving_generation',
].map((tableName) => {
  return {
    phase: 'mart_cleanup',
    tableName,
    whereSql: (projectId: string) => {
      return `project_id = ${getSqlLiteral(projectId)}`
    },
  }
})

const archivedProjectRuntimeCleanupMutations: CleanupMutation[] = [
  'app.project_mart_dirty_refresh_article_quarantine',
  'app.project_mart_refresh_article_state',
  'app.project_mart_dirty_materialization_state',
  'app.project_mart_refresh_state',
  'app.project_mart_large_rebuild_state',
].map((tableName) => {
  return {
    phase: 'runtime_state_cleanup',
    tableName,
    whereSql: (projectId: string) => {
      return `project_id = ${getSqlLiteral(projectId)}`
    },
  }
})

const archivedProjectJobCleanupMutations: CleanupMutation[] = [
  {
    phase: 'runtime_state_cleanup',
    tableName: 'app.judgment_job_sqlite_outbox_import',
    whereSql: (projectId: string) => {
      const projectLiteral = getSqlLiteral(projectId)

      return `project_id = ${projectLiteral} OR EXISTS (
        SELECT 1
        FROM app.judgment_job job
        WHERE job.id = app.judgment_job_sqlite_outbox_import.job_id
          AND job.project_id = ${projectLiteral}
      )`
    },
  },
  {
    phase: 'runtime_state_cleanup',
    tableName: 'app.judgment_job_sqlite_health_projection',
    whereSql: (projectId: string) => {
      return `EXISTS (
        SELECT 1
        FROM app.judgment_job job
        WHERE job.id = app.judgment_job_sqlite_health_projection.job_id
          AND job.project_id = ${getSqlLiteral(projectId)}
      )`
    },
  },
  {
    phase: 'runtime_state_cleanup',
    tableName: 'app.request_attempt_closeout',
    whereSql: (projectId: string) => {
      return `token_use_id IN (
        SELECT token_use.id
        FROM app.token_use token_use
        INNER JOIN app.judgment_job job ON job.id = token_use.judgment_job_id
        WHERE job.project_id = ${getSqlLiteral(projectId)}
      )`
    },
  },
  {
    phase: 'runtime_state_cleanup',
    tableName: 'app.token_use',
    whereSql: (projectId: string) => {
      return `EXISTS (
        SELECT 1
        FROM app.judgment_job job
        WHERE job.id = app.token_use.judgment_job_id
          AND job.project_id = ${getSqlLiteral(projectId)}
      )`
    },
  },
  {
    optional: true,
    phase: 'runtime_state_cleanup',
    tableName: 'app.judgment_job_prompt',
    whereSql: (projectId: string) => {
      return `EXISTS (
        SELECT 1
        FROM app.judgment_job job
        WHERE job.id = app.judgment_job_prompt.job_id
          AND job.project_id = ${getSqlLiteral(projectId)}
      )`
    },
  },
  {
    phase: 'runtime_state_cleanup',
    tableName: 'app.judgment_job',
    whereSql: (projectId: string) => {
      return `project_id = ${getSqlLiteral(projectId)}`
    },
  },
]

const archivedProjectSourceCleanupMutations: CleanupMutation[] = [
  {
    phase: 'source_cleanup',
    tableName: 'app.review',
    whereSql: (projectId: string) => {
      return `project_id = ${getSqlLiteral(projectId)}`
    },
  },
  {
    phase: 'source_cleanup',
    tableName: 'app.project_import_route',
    whereSql: (projectId: string) => {
      return `project_id = ${getSqlLiteral(projectId)}`
    },
  },
  {
    phase: 'source_cleanup',
    setSql: 'imported_from_project_id = NULL, updated_at = current_timestamp',
    tableName: 'app.project_article',
    whereSql: (projectId: string) => {
      return `imported_from_project_id = ${getSqlLiteral(projectId)}`
    },
  },
  {
    phase: 'source_cleanup',
    tableName: 'app.project_article',
    whereSql: (projectId: string) => {
      return `project_id = ${getSqlLiteral(projectId)}`
    },
  },
  {
    phase: 'source_cleanup',
    setSql: 'origin_project_id = NULL, updated_at = current_timestamp',
    tableName: 'app.project_prompt',
    whereSql: (projectId: string) => {
      return `origin_project_id = ${getSqlLiteral(projectId)}`
    },
  },
  {
    phase: 'source_cleanup',
    tableName: 'app.project_prompt',
    whereSql: (projectId: string) => {
      return `project_id = ${getSqlLiteral(projectId)}`
    },
  },
  {
    phase: 'source_cleanup',
    tableName: 'app.judgment_human_summary',
    whereSql: (projectId: string) => {
      return `project_id = ${getSqlLiteral(projectId)}`
    },
  },
  {
    phase: 'source_cleanup',
    setSql: 'project_id = NULL, updated_at = current_timestamp',
    tableName: 'app.judgment_human',
    whereSql: (projectId: string) => {
      return `project_id = ${getSqlLiteral(projectId)}`
    },
  },
  {
    phase: 'source_cleanup',
    setSql: 'project_id = NULL, updated_at = current_timestamp',
    tableName: 'app.judgment',
    whereSql: (projectId: string) => {
      return `project_id = ${getSqlLiteral(projectId)}`
    },
  },
  {
    phase: 'source_cleanup',
    setSql: 'project_id = NULL',
    tableName: 'mart.judgment_fact',
    whereSql: (projectId: string) => {
      return `project_id = ${getSqlLiteral(projectId)}`
    },
  },
  {
    phase: 'source_cleanup',
    tableName: 'app.comparison_project_source_project',
    whereSql: (projectId: string) => {
      return `source_project_id = ${getSqlLiteral(projectId)}`
    },
  },
  {
    phase: 'source_cleanup',
    setSql: 'summary_source_project_id = NULL, updated_at = current_timestamp',
    tableName: 'app.comparison_project',
    whereSql: (projectId: string) => {
      return `summary_source_project_id = ${getSqlLiteral(projectId)}`
    },
  },
]

const getUniqueProjectIds = (projectIds: string[]) => {
  return Array.from(
    new Set(
      projectIds
        .map((projectId) => {
          return projectId.trim()
        })
        .filter((projectId) => {
          return projectId !== ''
        }),
    ),
  )
}

const getProjectIdsSql = (projectIds: string[]) => {
  return getQuotedStringList(projectIds).join(', ')
}

const getTerminalJudgmentJobStatusesSql = () => {
  return getQuotedStringList(terminalJudgmentJobStatuses).join(', ')
}

const getMutationTableParts = (tableName: string) => {
  const [schemaName = '', localTableName = ''] = tableName.split('.')

  return {schemaName, tableName: localTableName}
}

const getTableExistsTx = async (tx: AppRunner, tableName: string) => {
  const parts = getMutationTableParts(tableName)
  const [row] = await tx.queryJson<{rowCount: number}>(`
    SELECT COUNT(*) AS rowCount
    FROM information_schema.tables
    WHERE table_schema = ${getSqlLiteral(parts.schemaName)}
      AND table_name = ${getSqlLiteral(parts.tableName)}
  `)

  return Number(row?.rowCount ?? 0) > 0
}

const getDeletePendingProject = async (projectId?: string) => {
  const whereProject = projectId === undefined ? '' : `AND tombstone.project_id = ${getSqlLiteral(projectId)}`
  const [project] = await getAppDatabaseService().queryJson<{id: string}>(`
    SELECT tombstone.project_id AS id
    FROM app.archived_project_delete_tombstone tombstone
    INNER JOIN app.project project ON project.id = tombstone.project_id
    WHERE project.archived = TRUE
      AND tombstone.completed_at IS NULL
      ${whereProject}
    ORDER BY tombstone.requested_at ASC, tombstone.project_id ASC
    LIMIT 1
  `)

  return project?.id ?? null
}

const getProjectRowsByIds = async (projectIds: string[]) => {
  return getAppDatabaseService().queryJson<ProjectArchivedStateRow>(`
    SELECT id, archived, delete_pending_at AS deletePendingAt
    FROM app.project
    WHERE id IN (${getProjectIdsSql(projectIds)})
  `)
}

const getActiveProjectIds = (rows: ProjectArchivedStateRow[]) => {
  return rows.reduce<string[]>((ids, row) => {
    return row.archived ? ids : [...ids, row.id]
  }, [])
}

const assertAllProjectsExistAndArchived = async (projectIds: string[]) => {
  const rows = await getProjectRowsByIds(projectIds)

  if (rows.length !== projectIds.length) {
    throw new Error('One or more projects not found')
  }

  const activeProjectIds = getActiveProjectIds(rows)

  if (activeProjectIds.length > 0) {
    throw new Error(`Only archived projects can be deleted: ${activeProjectIds.join(', ')}`)
  }
}

const markJudgmentJobsProjectRemovedTx = async (tx: AppRunner, projectIdsSql: string) => {
  await tx.run(`
    UPDATE app.judgment_job
    SET status = CASE
          WHEN status IN (${getTerminalJudgmentJobStatusesSql()}) THEN status
          ELSE 'project_removed'
        END,
        storage_state = CASE
          WHEN storage_state IN ('drained', 'quarantined') THEN storage_state
          ELSE 'draining'
        END,
        pause_requested_at = COALESCE(pause_requested_at, current_timestamp),
        updated_at = current_timestamp
    WHERE project_id IN (${projectIdsSql})
  `)
}

export const requestArchivedProjectDeletePending = async (
  projectIds: string[],
): Promise<ArchivedProjectDeletePendingResult> => {
  const uniqueProjectIds = getUniqueProjectIds(projectIds)

  if (uniqueProjectIds.length === 0) {
    return {projectIds: []}
  }

  await assertAllProjectsExistAndArchived(uniqueProjectIds)
  await getAppDatabaseService().transaction(async (tx) => {
    const projectIdsSql = getProjectIdsSql(uniqueProjectIds)

    await tx.run(`
      INSERT INTO app.archived_project_delete_tombstone (project_id)
      SELECT project.id
      FROM app.project project
      WHERE project.id IN (${projectIdsSql})
        AND project.archived = TRUE
        AND NOT EXISTS (
          SELECT 1
          FROM app.archived_project_delete_tombstone tombstone
          WHERE tombstone.project_id = project.id
        )
    `)
    await markJudgmentJobsProjectRemovedTx(tx, projectIdsSql)
  })

  return {projectIds: uniqueProjectIds}
}

const getRowIdsSql = (rowIds: RowIdRow[]) => {
  return rowIds
    .map((row) => {
      return getSqlLiteral(row.rowId)
    })
    .join(', ')
}

const mutateRowsBatchTx = async (tx: AppRunner, mutation: CleanupMutation, projectId: string, batchSize: number) => {
  if (mutation.optional && !(await getTableExistsTx(tx, mutation.tableName))) {
    return 0
  }

  const rowIds = await tx.queryJson<RowIdRow>(`
    SELECT rowid AS rowId
    FROM ${mutation.tableName}
    WHERE ${mutation.whereSql(projectId)}
    ORDER BY rowid ASC
    LIMIT ${batchSize}
  `)

  if (rowIds.length === 0) {
    return 0
  }

  const mutationSql =
    mutation.setSql === undefined
      ? `DELETE FROM ${mutation.tableName}`
      : `UPDATE ${mutation.tableName} SET ${mutation.setSql}`

  await tx.run(`
    ${mutationSql}
    WHERE rowid IN (${getRowIdsSql(rowIds)})
  `)

  return rowIds.length
}

const mutateRowsBatch = async (mutation: CleanupMutation, projectId: string, batchSize: number): Promise<number> => {
  return getAppDatabaseService().transaction(async (tx) => {
    return mutateRowsBatchTx(tx, mutation, projectId, batchSize)
  }) as Promise<number>
}

const runFirstMutationBatch = async (
  mutations: CleanupMutation[],
  projectId: string,
  batchSize: number,
): Promise<ArchivedProjectCleanupBatchResult | null> => {
  const [mutation] = mutations

  if (!mutation) {
    return null
  }

  const deletedRowCount = await mutateRowsBatch(mutation, projectId, batchSize)

  return deletedRowCount > 0
    ? {deletedRowCount, phase: mutation.phase, projectId, tableName: mutation.tableName}
    : runFirstMutationBatch(mutations.slice(1), projectId, batchSize)
}

const cleanupTombstonedRuntimeReferences = async (projectId: string, batchSize: number) => {
  await getAppDatabaseService().transaction(async (tx) => {
    await markJudgmentJobsProjectRemovedTx(tx, getSqlLiteral(projectId))
  })

  return runFirstMutationBatch(
    [...archivedProjectRuntimeCleanupMutations, ...archivedProjectJobCleanupMutations],
    projectId,
    batchSize,
  )
}

const cleanupTombstonedSourceReferences = async (projectId: string, batchSize: number) => {
  return runFirstMutationBatch(archivedProjectSourceCleanupMutations, projectId, batchSize)
}

const getProjectForeignKeyInventoryTx = async (tx: AppRunner) => {
  return tx.queryJson<ProjectForeignKeyInventoryRow>(`
    SELECT
      schema_name AS schemaName,
      table_name AS tableName,
      unnest(constraint_column_names) AS columnName
    FROM duckdb_constraints()
    WHERE schema_name = 'app'
      AND constraint_type = 'FOREIGN KEY'
      AND referenced_table = 'project'
    ORDER BY table_name ASC, columnName ASC
  `)
}

const getRemainingProjectForeignKeyRowsTx = async (tx: AppRunner, projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)
  const inventoryRows = await getProjectForeignKeyInventoryTx(tx)
  const rows = await Promise.all(
    inventoryRows.map(async ({columnName, schemaName, tableName}) => {
      if (!(await getTableExistsTx(tx, `${schemaName}.${tableName}`))) {
        return {columnName, rowCount: 0, tableName}
      }

      const [row] = await tx.queryJson<RemainingProjectReferenceRow>(`
        SELECT
          ${getSqlLiteral(tableName)} AS tableName,
          ${getSqlLiteral(columnName)} AS columnName,
          COUNT(*) AS rowCount
        FROM ${schemaName}.${tableName}
        WHERE ${columnName} = ${projectLiteral}
      `)

      return row ?? {columnName, rowCount: 0, tableName}
    }),
  )

  return rows.filter((row) => {
    return Number(row.rowCount ?? 0) > 0
  })
}

const getRemainingMartCleanupRowsTx = async (tx: AppRunner, projectId: string) => {
  const projectLiteral = getSqlLiteral(projectId)
  const rows = await Promise.all(
    archivedProjectMartCleanupMutations.map(async ({tableName}) => {
      const [row] = await tx.queryJson<RemainingProjectReferenceRow>(`
        SELECT
          ${getSqlLiteral(tableName)} AS tableName,
          'project_id' AS columnName,
          COUNT(*) AS rowCount
        FROM ${tableName}
        WHERE project_id = ${projectLiteral}
      `)

      return row ?? {columnName: 'project_id', rowCount: 0, tableName}
    }),
  )

  return rows.filter((row) => {
    return Number(row.rowCount ?? 0) > 0
  })
}

const getFinalDeleteBlocked = async (tx: AppRunner, projectId: string) => {
  const foreignKeyRows = await getRemainingProjectForeignKeyRowsTx(tx, projectId)
  const martRows = await getRemainingMartCleanupRowsTx(tx, projectId)

  return foreignKeyRows.length > 0 || martRows.length > 0
}

const finalDeleteProject = async (projectId: string): Promise<ArchivedProjectCleanupBatchResult | null> => {
  return getAppDatabaseService().transaction(async (tx) => {
    if (await getFinalDeleteBlocked(tx, projectId)) {
      return null
    }

    await tx.run(`
      DELETE FROM app.archived_project_delete_tombstone
      WHERE project_id = ${getSqlLiteral(projectId)}
    `)
    await tx.run(`
      DELETE FROM app.project
      WHERE id = ${getSqlLiteral(projectId)}
        AND archived = TRUE
    `)

    return {deletedRowCount: 1, phase: 'final_delete', projectId, tableName: 'app.project'}
  }) as Promise<ArchivedProjectCleanupBatchResult | null>
}

const recordTombstoneCleanupResult = async (result: ArchivedProjectCleanupBatchResult) => {
  if (result.projectId === null || result.phase === 'final_delete' || result.phase === 'idle') {
    return
  }

  await getAppDatabaseService().run(`
    UPDATE app.archived_project_delete_tombstone
    SET last_cleanup_at = current_timestamp,
        last_cleanup_phase = ${getSqlLiteral(result.phase)},
        last_cleanup_table = ${getSqlLiteral(result.tableName)},
        last_deleted_row_count = ${getSqlLiteral(result.deletedRowCount)},
        updated_at = current_timestamp
    WHERE project_id = ${getSqlLiteral(result.projectId)}
  `)
}

export const cleanupNextArchivedProjectBatch = async (
  params: {batchSize?: number; projectId?: string} = {},
): Promise<ArchivedProjectCleanupBatchResult> => {
  const batchSize = params.batchSize ?? defaultCleanupBatchSize
  const projectId = await getDeletePendingProject(params.projectId)

  if (projectId === null) {
    return {deletedRowCount: 0, phase: 'idle', projectId: null, tableName: null}
  }

  const martResult = await runFirstMutationBatch(archivedProjectMartCleanupMutations, projectId, batchSize)
  const runtimeResult = martResult ?? (await cleanupTombstonedRuntimeReferences(projectId, batchSize))
  const sourceResult = runtimeResult ?? (await cleanupTombstonedSourceReferences(projectId, batchSize))
  const finalResult = sourceResult ?? (await finalDeleteProject(projectId))
  const result = finalResult ?? {deletedRowCount: 0, phase: 'tombstone_cleanup', projectId, tableName: null}

  await recordTombstoneCleanupResult(result)

  return result
}

const runArchivedProjectCleanupBatches = async (params: {
  batchSize: number
  batches: ArchivedProjectCleanupBatchResult[]
  maxBatches: number
}): Promise<ArchivedProjectCleanupBatchResult[]> => {
  if (params.batches.length >= params.maxBatches) {
    return params.batches
  }

  const result = await cleanupNextArchivedProjectBatch({batchSize: params.batchSize})
  const nextBatches = [...params.batches, result]

  return result.phase === 'idle' || result.deletedRowCount === 0
    ? nextBatches
    : runArchivedProjectCleanupBatches({...params, batches: nextBatches})
}

export const runArchivedProjectBoundedCleanup = async (
  params: {batchSize?: number; maxBatches?: number} = {},
): Promise<ArchivedProjectCleanupRunResult> => {
  const batches = await runArchivedProjectCleanupBatches({
    batchSize: params.batchSize ?? defaultCleanupBatchSize,
    batches: [],
    maxBatches: params.maxBatches ?? defaultMaxCleanupBatches,
  })
  const deletedRowCount = batches.reduce((total, batch) => {
    return total + batch.deletedRowCount
  }, 0)
  const [lastBatch] = batches.slice(-1)
  const reachedLimit = batches.length >= (params.maxBatches ?? defaultMaxCleanupBatches)
  const status =
    lastBatch?.phase === 'idle' || lastBatch?.deletedRowCount === 0 || !reachedLimit ? 'completed' : 'stopped'

  return {batches, deletedRowCount, status}
}

export const getArchivedProjectCleanupService = () => {
  return {cleanupNextArchivedProjectBatch, requestArchivedProjectDeletePending, runArchivedProjectBoundedCleanup}
}
