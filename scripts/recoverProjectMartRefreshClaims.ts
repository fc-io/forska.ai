import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'

type CliOptions = {recover: boolean; yes: boolean}

type RecoveryResult = {
  claimedToken?: number
  error?: string
  projectId: string | null
  status: 'completed' | 'failed' | 'idle'
  workerId: string
}

type StaleClaimRow = {
  dirtyToken: number | string
  lastCompletedDirtyToken: number | string
  leaseExpiresAt: string
  projectId: string
  workerId: string | null
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

const getStaleClaims = async () => {
  return getAppDatabaseService().queryJson<StaleClaimRow>(`
    SELECT
      project_id AS projectId,
      dirty_token AS dirtyToken,
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

const getSummary = (staleClaims: StaleClaimRow[]) => {
  return staleClaims.map((claim) => {
    return {
      dirtyToken: toNumber(claim.dirtyToken),
      lastCompletedDirtyToken: toNumber(claim.lastCompletedDirtyToken),
      leaseExpiresAt: claim.leaseExpiresAt,
      projectId: claim.projectId,
      workerId: claim.workerId,
    }
  })
}

const runIsolatedRecovery = () => {
  const result = globalThis.Bun.spawnSync(['bun', 'scripts/runProjectMartRefreshWorkerOnceIsolated.ts'], {
    cwd: process.cwd(),
    env: {...process.env, SERVER_DUCKDB_OWNER_URL: '', SERVER_ROLE: 'maintenance-worker'},
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const output = result.stdout.toString().trim()
  const lastLine = output
    .split(/\r?\n/)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.startsWith('{') && line.endsWith('}')
    })
    .slice(-1)[0]

  if (!lastLine) {
    throw new Error(result.stderr.toString() || output || 'Missing JSON output from isolated recovery worker')
  }

  return JSON.parse(lastLine) as RecoveryResult
}

export const recoverProjectMartRefreshClaims = async () => {
  const options = getCliOptions()

  try {
    const staleClaims = await getStaleClaims()
    const staleClaimSummary = getSummary(staleClaims)

    if (!options.recover) {
      console.log(JSON.stringify({recoverAttempted: false, staleClaims: staleClaimSummary, status: 'listed'}))
      return
    }

    if (!options.yes) {
      throw new Error('Refusing recovery without --yes')
    }

    await getAppDatabaseService().close()
    const recoveryResult = runIsolatedRecovery()

    console.log(
      JSON.stringify({recoverAttempted: true, recoveryResult, staleClaims: staleClaimSummary, status: 'recovered'}),
    )
  } finally {
    await getAppDatabaseService().close()
  }
}

if (import.meta.main) {
  await recoverProjectMartRefreshClaims()
}
