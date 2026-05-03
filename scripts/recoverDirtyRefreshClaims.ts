import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'

type CliOptions = {recover: boolean; yes: boolean}

type RecoveryResult = {
  command: string
  result: unknown
}

type StaleDirtyRefreshClaimRow = {
  activeDirtyToken: number | string
  dirtyToken: number | string
  lastCompletedDirtyToken: number | string
  leaseExpiresAt: string
  projectId: string
  workerId: string | null
}

type StaleDirtyMaterializationClaimRow = {
  insertedRowCount: number | string
  leaseExpiresAt: string
  materializationOwner: string | null
  projectId: string
  sourceKind: string
  targetDirtyToken: number | string
}

type StaleLargeRebuildClaimRow = {
  leaseExpiresAt: string
  projectId: string
  rebuildPhase: string
  refreshToken: number | string
  workerId: string | null
}

type QuarantineBarrierRow = {
  articleId: string
  dirtyToken: number | string
  projectId: string
}

const getBooleanFlag = (names: string[]) => {
  return process.argv.slice(2).some((argument) => {
    return names.includes(argument)
  })
}

const getCliOptions = (): CliOptions => {
  return {recover: getBooleanFlag(['--recover']), yes: getBooleanFlag(['--yes'])}
}

const toNumber = (value: number | string | null | undefined) => {
  return Number(value ?? 0)
}

const getStaleDirtyRefreshClaims = async () => {
  return getAppDatabaseService().queryJson<StaleDirtyRefreshClaimRow>(`
    SELECT
      project_id AS projectId,
      dirty_token AS dirtyToken,
      active_dirty_token AS activeDirtyToken,
      last_completed_dirty_token AS lastCompletedDirtyToken,
      lease_expires_at AS leaseExpiresAt,
      worker_id AS workerId
    FROM app.project_mart_refresh_state
    WHERE refresh_status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < NOW()
      AND dirty_token > last_completed_dirty_token
    ORDER BY lease_expires_at ASC, project_id ASC
  `)
}

const getStaleDirtyMaterializationClaims = async () => {
  return getAppDatabaseService().queryJson<StaleDirtyMaterializationClaimRow>(`
    SELECT
      project_id AS projectId,
      source_kind AS sourceKind,
      target_dirty_token AS targetDirtyToken,
      inserted_row_count AS insertedRowCount,
      materialization_owner AS materializationOwner,
      lease_expires_at AS leaseExpiresAt
    FROM app.project_mart_dirty_materialization_state
    WHERE materialization_status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < NOW()
    ORDER BY lease_expires_at ASC, target_dirty_token ASC, project_id ASC, source_kind ASC
  `)
}

const getStaleLargeRebuildClaims = async () => {
  return getAppDatabaseService().queryJson<StaleLargeRebuildClaimRow>(`
    SELECT
      project_id AS projectId,
      refresh_token AS refreshToken,
      rebuild_phase AS rebuildPhase,
      lease_expires_at AS leaseExpiresAt,
      worker_id AS workerId
    FROM app.project_mart_large_rebuild_state
    WHERE refresh_status = 'running'
      AND refresh_token > 0
      AND superseded_at IS NULL
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < NOW()
    ORDER BY lease_expires_at ASC, refresh_token ASC, project_id ASC
  `)
}

const getQuarantineBarriers = async () => {
  return getAppDatabaseService().queryJson<QuarantineBarrierRow>(`
    SELECT
      project_id AS projectId,
      article_id AS articleId,
      dirty_token AS dirtyToken
    FROM app.project_mart_dirty_refresh_article_quarantine
    WHERE resolved_at IS NULL
    ORDER BY project_id ASC, dirty_token ASC, article_id ASC
  `)
}

const getDirtyRefreshSummary = (rows: StaleDirtyRefreshClaimRow[]) => {
  return rows.map((row) => {
    return {
      activeDirtyToken: toNumber(row.activeDirtyToken),
      dirtyToken: toNumber(row.dirtyToken),
      lastCompletedDirtyToken: toNumber(row.lastCompletedDirtyToken),
      leaseExpiresAt: row.leaseExpiresAt,
      projectId: row.projectId,
      workerId: row.workerId,
    }
  })
}

const getDirtyMaterializationSummary = (rows: StaleDirtyMaterializationClaimRow[]) => {
  return rows.map((row) => {
    return {
      insertedRowCount: toNumber(row.insertedRowCount),
      leaseExpiresAt: row.leaseExpiresAt,
      materializationOwner: row.materializationOwner,
      projectId: row.projectId,
      sourceKind: row.sourceKind,
      targetDirtyToken: toNumber(row.targetDirtyToken),
    }
  })
}

const getLargeRebuildSummary = (rows: StaleLargeRebuildClaimRow[]) => {
  return rows.map((row) => {
    return {
      leaseExpiresAt: row.leaseExpiresAt,
      projectId: row.projectId,
      rebuildPhase: row.rebuildPhase,
      refreshToken: toNumber(row.refreshToken),
      workerId: row.workerId,
    }
  })
}

const getQuarantineBarrierSummary = (rows: QuarantineBarrierRow[]) => {
  return rows.map((row) => {
    return {
      articleId: row.articleId,
      dirtyToken: toNumber(row.dirtyToken),
      projectId: row.projectId,
    }
  })
}

const getLastJsonLine = (output: string) => {
  return output
    .split(/\r?\n/)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.startsWith('{') && line.endsWith('}')
    })
    .slice(-1)[0]
}

const runRecoveryCommand = (command: string, args: string[]) => {
  const result = globalThis.Bun.spawnSync(['bun', command, ...args], {
    cwd: process.cwd(),
    env: {...process.env, SERVER_DUCKDB_OWNER_URL: '', SERVER_ROLE: 'maintenance-worker'},
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const output = result.stdout.toString().trim()
  const lastLine = getLastJsonLine(output)

  if (result.exitCode !== 0 || !lastLine) {
    throw new Error(result.stderr.toString() || output || `Missing JSON output from ${command}`)
  }

  return JSON.parse(lastLine) as unknown
}

const recoverDirtyMaterializations = (rows: StaleDirtyMaterializationClaimRow[]) => {
  return rows.length === 0
    ? []
    : [
        {
          command: 'scripts/runProjectMartRefreshWorkerOnce.ts',
          result: runRecoveryCommand('scripts/runProjectMartRefreshWorkerOnce.ts', [
            '--worker-id=dirty-refresh-materialization-recovery',
          ]),
        },
      ]
}

const recoverDirtyRefreshClaims = (rows: StaleDirtyRefreshClaimRow[]) => {
  return rows.reduce<RecoveryResult[]>((acc, row) => {
    return [
      ...acc,
      {
        command: 'scripts/runProjectMartRefreshWorkerOnceIsolated.ts',
        result: runRecoveryCommand('scripts/runProjectMartRefreshWorkerOnceIsolated.ts', [
          `--project-id=${row.projectId}`,
          '--worker-id=dirty-refresh-claim-recovery',
        ]),
      },
    ]
  }, [])
}

const recoverLargeRebuildClaims = (rows: StaleLargeRebuildClaimRow[]) => {
  return rows.length === 0
    ? []
    : [
        {
          command: 'scripts/runLargeRebuildWorkerOnce.ts',
          result: runRecoveryCommand('scripts/runLargeRebuildWorkerOnce.ts', [
            '--worker-id=dirty-refresh-large-rebuild-recovery',
          ]),
        },
      ]
}

export const recoverDirtyRefreshClaimState = async () => {
  const options = getCliOptions()

  try {
    const [dirtyRefreshClaims, dirtyMaterializations, largeRebuildClaims, quarantineBarriers] = await Promise.all([
      getStaleDirtyRefreshClaims(),
      getStaleDirtyMaterializationClaims(),
      getStaleLargeRebuildClaims(),
      getQuarantineBarriers(),
    ])
    const staleClaims = getDirtyRefreshSummary(dirtyRefreshClaims)
    const staleDirtyMaterializations = getDirtyMaterializationSummary(dirtyMaterializations)
    const staleLargeRebuildClaims = getLargeRebuildSummary(largeRebuildClaims)
    const unresolvedQuarantineBarriers = getQuarantineBarrierSummary(quarantineBarriers)

    if (!options.recover) {
      console.log(
        JSON.stringify({
          recoverAttempted: false,
          staleClaims,
          staleDirtyMaterializations,
          staleLargeRebuildClaims,
          status: 'listed',
          unresolvedQuarantineBarriers,
        }),
      )
      return
    }

    if (!options.yes) {
      throw new Error('Refusing recovery without --yes')
    }

    await getAppDatabaseService().close()
    const recoveryResults = [
      ...recoverDirtyMaterializations(dirtyMaterializations),
      ...recoverDirtyRefreshClaims(dirtyRefreshClaims),
      ...recoverLargeRebuildClaims(largeRebuildClaims),
    ]

    console.log(
      JSON.stringify({
        recoverAttempted: true,
        recoveryResult: recoveryResults[0]?.result ?? null,
        recoveryResults,
        staleClaims,
        staleDirtyMaterializations,
        staleLargeRebuildClaims,
        status: 'recovered',
        unresolvedQuarantineBarriers,
      }),
    )
  } finally {
    await getAppDatabaseService().close()
  }
}

if (import.meta.main) {
  await recoverDirtyRefreshClaimState()
}
