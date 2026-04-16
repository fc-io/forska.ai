import {claimJudgmentJobSqliteImportBatch} from './judgmentJobSqliteOutboxImport.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'

type CliOptions = {claimedBy: string | null; jobId: string | null}

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1) ?? null
}

const getCliOptions = (): CliOptions => {
  return {claimedBy: getArgValue(['--claimedBy', '--claimed-by']), jobId: getArgValue(['--jobId', '--job-id'])}
}

const closeResources = async () => {
  await getJudgmentJobSqliteService().closeAll()
}

export const runJudgmentJobSqliteSingleJobClaimExport = async () => {
  const options = getCliOptions()

  if (!options.jobId || !options.claimedBy) {
    process.exitCode = 1
    console.log(
      JSON.stringify({
        claimedBy: options.claimedBy,
        error: 'Expected --jobId=<job-id> and --claimedBy=<claimed-by>',
        jobId: options.jobId,
        status: 'failed',
      }),
    )

    await closeResources()

    return
  }

  try {
    const claimedBatch = await claimJudgmentJobSqliteImportBatch({claimedBy: options.claimedBy, jobId: options.jobId})

    console.log(
      JSON.stringify({
        claimedBatch,
        claimedBy: options.claimedBy,
        jobId: options.jobId,
        status: claimedBatch ? 'claimed' : 'idle',
      }),
    )
  } catch (error) {
    process.exitCode = 1
    console.log(
      JSON.stringify({
        claimedBy: options.claimedBy,
        error: error instanceof Error ? error.message : String(error),
        jobId: options.jobId,
        status: 'failed',
      }),
    )
  } finally {
    await closeResources()
  }
}

if (import.meta.main) {
  await runJudgmentJobSqliteSingleJobClaimExport()
}
