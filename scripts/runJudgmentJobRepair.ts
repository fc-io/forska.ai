import {
  type JudgmentJobRepairAction,
  runJudgmentJobRepairAction,
} from '../src/server/cron/judgmentsJobs/judgmentJobRepair.ts'
import {
  getJudgmentJobSqliteService,
  type JudgmentJobSystemSqliteFallbackStep,
} from '../src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

type CliOptions = {
  action: JudgmentJobRepairAction | null
  claimedBy: string | null
  jobId: string | null
  reason: string | null
  systemSqliteFallbackSteps: JudgmentJobSystemSqliteFallbackStep[]
}

const repairActions = new Set<JudgmentJobRepairAction>([
  'checkpoint',
  'drain',
  'preflight',
  'quarantine',
  'repair',
  'repair_orphaned_queue',
  'unquarantine',
])
const systemSqliteFallbackSteps = new Set<JudgmentJobSystemSqliteFallbackStep>(['checkpoint', 'diagnostic', 'export'])

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1) ?? null
}

const getCliOptions = (): CliOptions => {
  const rawAction = getArgValue(['--action'])
  const rawSystemSqliteFallbackSteps = getArgValue(['--systemSqliteFallbackSteps', '--system-sqlite-fallback-steps'])

  return {
    action:
      rawAction && repairActions.has(rawAction as JudgmentJobRepairAction)
        ? (rawAction as JudgmentJobRepairAction)
        : null,
    claimedBy: getArgValue(['--claimedBy', '--claimed-by']),
    jobId: getArgValue(['--jobId', '--job-id']),
    reason: getArgValue(['--reason']),
    systemSqliteFallbackSteps: [...new Set((rawSystemSqliteFallbackSteps ?? '').split(','))].flatMap((step) => {
      const normalizedStep = step.trim()
      return systemSqliteFallbackSteps.has(normalizedStep as JudgmentJobSystemSqliteFallbackStep)
        ? [normalizedStep as JudgmentJobSystemSqliteFallbackStep]
        : []
    }),
  }
}

const closeResources = async () => {
  await Promise.allSettled([getJudgmentJobSqliteService().closeAll(), getAppDatabaseService().close()])
}

export const runJudgmentJobRepair = async () => {
  const options = getCliOptions()

  if (!options.jobId || !options.action) {
    process.exitCode = 1
    console.log(
      JSON.stringify({
        action: options.action,
        error:
          'Expected --jobId=<job-id> and '
          + '--action=<preflight|drain|checkpoint|quarantine|unquarantine|repair|repair_orphaned_queue>',
        jobId: options.jobId,
        status: 'failed',
        systemSqliteFallbackSteps: options.systemSqliteFallbackSteps,
      }),
    )

    await closeResources()

    return
  }

  const action = options.action
  const jobId = options.jobId

  try {
    const result = await withDuckdbMaintenanceAccess('judgment job repair', async () => {
      return runJudgmentJobRepairAction({
        action,
        allowOfflineRepairForQuarantinedLocalState: true,
        claimedBy: options.claimedBy,
        jobId,
        reason: options.reason,
        systemSqliteFallbackSteps: options.systemSqliteFallbackSteps,
      })
    })

    process.exitCode = result.ok ? 0 : 1
    console.log(JSON.stringify(result))
  } catch (error) {
    process.exitCode = 1
    console.log(
      JSON.stringify({action, error: error instanceof Error ? error.message : String(error), jobId, status: 'failed'}),
    )
  } finally {
    await closeResources()
  }
}

if (import.meta.main) {
  await runJudgmentJobRepair()
}
