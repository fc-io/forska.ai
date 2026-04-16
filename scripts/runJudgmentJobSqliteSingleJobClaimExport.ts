export {runJudgmentJobSqliteSingleJobClaimExport} from '../src/server/cron/judgmentsJobs/runJudgmentJobSqliteSingleJobClaimExport.ts'

if (import.meta.main) {
  const {runJudgmentJobSqliteSingleJobClaimExport} =
    await import('../src/server/cron/judgmentsJobs/runJudgmentJobSqliteSingleJobClaimExport.ts')

  await runJudgmentJobSqliteSingleJobClaimExport()
}
