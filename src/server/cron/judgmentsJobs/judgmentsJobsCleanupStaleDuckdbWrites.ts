import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'

export const sqliteCleanupTerminalStatuses = ['completed', 'paused', 'project_removed'] as const

export const finalizeMissingLocalSqliteDrainingJobs = async (jobIds: string[]): Promise<void> => {
  return jobIds.length === 0
    ? Promise.resolve()
    : getAppDatabaseService().run(`
        UPDATE app.judgment_job
        SET storage_state = ${getSqlLiteral('drained')},
            updated_at = current_timestamp
        WHERE id IN (${getQuotedStringList(jobIds).join(', ')})
          AND storage_state = ${getSqlLiteral('draining')}
          AND status IN (${getQuotedStringList([...sqliteCleanupTerminalStatuses]).join(', ')})
      `)
}

export const resumeRecoveredOomQuarantinedJob = async (jobId: string): Promise<void> => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET status = ${getSqlLiteral('running')},
        pause_requested_at = NULL,
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
      AND storage_state = ${getSqlLiteral('active')}
      AND status = ${getSqlLiteral('paused')}
      AND pause_requested_at IS NULL
  `)
}
