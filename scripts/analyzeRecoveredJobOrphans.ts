import {getJudgmentJobSqlitePath} from '../src/server/cron/judgmentsJobs/judgmentJobPaths.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getSqlLiteral} from '../src/server/services/appQueryHelpers.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

type CliOptions = {jobId: string | null}
type JobInfoRow = {
  modelId: string
  useAbstract: number
  useFulltext: number
  useFulltextNoImages: number
  useTitle: number
}
type OrphanQueuePromptRow = {articleId: string; promptId: string; queuePromptId: string}

const workloadContext = getMaintenanceDuckdbWorkloadContext('analyzeRecoveredJobOrphans')

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1) ?? null
}

const getCliOptions = (): CliOptions => {
  return {jobId: getArgValue(['--jobId', '--job-id'])}
}

const getTrimmedStdout = (stdout: string) => {
  const trimmed = stdout.trim()
  return trimmed === '' ? '[]' : trimmed
}

const runSqliteJsonQuery = <T>(sqlitePath: string, sql: string): T[] => {
  const result = globalThis.Bun.spawnSync(['sqlite3', '-readonly', '-json', sqlitePath, sql], {
    cwd: process.cwd(),
    env: {...process.env},
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || `sqlite3 query failed for ${sqlitePath}`)
  }

  return JSON.parse(getTrimmedStdout(result.stdout.toString())) as T[]
}

const getJobInfoSql = (jobId: string) => {
  return `
    SELECT
      model_id AS modelId,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      use_title AS useTitle
    FROM job_info
    WHERE job_id = ${getSqlLiteral(jobId)}
    LIMIT 1
  `
}

const getOrphanQueuePromptSql = () => {
  return `
    SELECT
      article_id AS articleId,
      prompt_id AS promptId,
      id AS queuePromptId
    FROM queue_prompt qp
    WHERE status = 'judged'
      AND NOT EXISTS (
        SELECT 1
        FROM judgment_outbox jo
        WHERE jo.queue_prompt_id = qp.id
      )
    ORDER BY id ASC
  `
}

export const runAnalyzeRecoveredJobOrphans = async () => {
  const options = getCliOptions()

  if (!options.jobId) {
    process.exitCode = 1
    console.log(JSON.stringify({error: 'Expected --jobId=<job-id>', status: 'failed'}))
    return
  }

  const sqlitePath = getJudgmentJobSqlitePath(options.jobId)
  const [jobInfo] = runSqliteJsonQuery<JobInfoRow>(sqlitePath, getJobInfoSql(options.jobId))
  const orphanRows = runSqliteJsonQuery<OrphanQueuePromptRow>(sqlitePath, getOrphanQueuePromptSql())

  if (!jobInfo) {
    throw new Error(`Missing job_info for ${options.jobId}`)
  }

  const chunkSize = 500
  const summary = await withDuckdbMaintenanceAccess('analyze recovered job orphans', async () => {
    return orphanRows.reduce<Promise<{currentModel: number; anyModel: number}>>(
      async (promise, _row, index) => {
        if (index % chunkSize !== 0) {
          return promise
        }

        const current = await promise
        const chunk = orphanRows.slice(index, index + chunkSize)

        if (chunk.length === 0) {
          return current
        }

        const pairPredicate = chunk
          .map((row) => {
            return `(article_id = ${getSqlLiteral(row.articleId)} AND prompt_id = ${getSqlLiteral(row.promptId)})`
          })
          .join(' OR ')

        const [[currentModelRow = {count: 0}], [anyModelRow = {count: 0}]] = await Promise.all([
          getAppDatabaseService().queryJson<{count: number | string}>(
            `
          SELECT COUNT(*) AS count
          FROM app.judgment
          WHERE model_id = ${getSqlLiteral(jobInfo.modelId)}
            AND use_title = ${getSqlLiteral(Boolean(jobInfo.useTitle))}
            AND use_abstract = ${getSqlLiteral(Boolean(jobInfo.useAbstract))}
            AND use_fulltext = ${getSqlLiteral(Boolean(jobInfo.useFulltext))}
            AND use_fulltext_no_images = ${getSqlLiteral(Boolean(jobInfo.useFulltextNoImages))}
            AND delete_generation = 0
            AND deleted_at IS NULL
            AND (${pairPredicate})
        `,
            {...workloadContext, maxResultRows: 1},
          ),
          getAppDatabaseService().queryJson<{count: number | string}>(
            `
          SELECT COUNT(*) AS count
          FROM app.judgment
          WHERE delete_generation = 0
            AND deleted_at IS NULL
            AND (${pairPredicate})
        `,
            {...workloadContext, maxResultRows: 1},
          ),
        ])

        return {
          anyModel: current.anyModel + Number(anyModelRow.count ?? 0),
          currentModel: current.currentModel + Number(currentModelRow.count ?? 0),
        }
      },
      Promise.resolve({anyModel: 0, currentModel: 0}),
    )
  })

  console.log(
    JSON.stringify({
      jobId: options.jobId,
      orphanQueueRows: orphanRows.length,
      judgmentsForAnyModel: summary.anyModel,
      judgmentsForCurrentModel: summary.currentModel,
      status: 'ok',
    }),
  )
}

if (import.meta.main) {
  await runAnalyzeRecoveredJobOrphans()
}
