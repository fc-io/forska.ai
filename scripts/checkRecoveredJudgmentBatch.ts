import {readFile} from 'node:fs/promises'

import {getJudgmentJobSqlitePath} from '../src/server/cron/judgmentsJobs/judgmentJobPaths.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getSqlLiteral} from '../src/server/services/appQueryHelpers.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

type CliOptions = {jobId: string | null; limit: number; offset: number}
type ExportedOutboxRow = {
  articleId: string
  modelId: string
  outboxSeq: number
  promptId: string
  useAbstract: number
  useFulltext: number
  useFulltextNoImages: number
  useTitle: number
}

const workloadContext = getMaintenanceDuckdbWorkloadContext('checkRecoveredJudgmentBatch')

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1) ?? null
}

const getCliOptions = (): CliOptions => {
  return {
    jobId: getArgValue(['--jobId', '--job-id']),
    limit: Number(getArgValue(['--limit']) ?? 100),
    offset: Number(getArgValue(['--offset']) ?? 0),
  }
}

const checkBatch = async ({jobId, limit, offset}: {jobId: string; limit: number; offset: number}) => {
  const exportPath = `${getJudgmentJobSqlitePath(jobId)}.recovery-export.json`
  const rows = JSON.parse(await readFile(exportPath, 'utf8')) as ExportedOutboxRow[]
  const batch = rows.slice(offset, offset + limit)

  const db = getAppDatabaseService()

  try {
    const missingOutboxSeqs = await withDuckdbMaintenanceAccess('check recovered judgment batch', async () => {
      return batch.reduce<Promise<number[]>>(async (promise, row) => {
        const missing = await promise
        const result = await db.queryJson<{count: number | string}>(
          `
          SELECT COUNT(*) AS count
          FROM app.judgment
          WHERE article_id = ${getSqlLiteral(row.articleId)}
            AND prompt_id = ${getSqlLiteral(row.promptId)}
            AND model_id = ${getSqlLiteral(row.modelId)}
            AND use_title = ${getSqlLiteral(row.useTitle === 1)}
            AND use_abstract = ${getSqlLiteral(row.useAbstract === 1)}
            AND use_fulltext = ${getSqlLiteral(row.useFulltext === 1)}
            AND use_fulltext_no_images = ${getSqlLiteral(row.useFulltextNoImages === 1)}
            AND delete_generation = 0
            AND deleted_at IS NULL
        `,
          {...workloadContext, maxResultRows: 1},
        )

        return Number(result[0]?.count ?? 0) > 0 ? missing : [...missing, row.outboxSeq]
      }, Promise.resolve([]))
    })

    return {checked: batch.length, missingOutboxSeqs, offset}
  } finally {
    await db.close()
  }
}

export const runCheckRecoveredJudgmentBatch = async () => {
  const options = getCliOptions()

  if (!options.jobId) {
    process.exitCode = 1
    console.log(JSON.stringify({error: 'Expected --jobId=<job-id>', status: 'failed'}))
    return
  }

  try {
    const result = await checkBatch(options as {jobId: string; limit: number; offset: number})

    if (result.missingOutboxSeqs.length > 0) {
      process.exitCode = 1
    }

    console.log(JSON.stringify({status: result.missingOutboxSeqs.length === 0 ? 'ok' : 'missing', ...result}))
  } catch (error) {
    process.exitCode = 1
    console.log(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        jobId: options.jobId,
        status: 'failed',
      }),
    )
  }
}

if (import.meta.main) {
  await runCheckRecoveredJudgmentBatch()
}
