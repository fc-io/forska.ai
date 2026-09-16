import {writeFileSync} from 'node:fs'

import {
  defaultJudgmentRepairV4RebuildComponents,
  requestReviewServingV4Rebuild,
} from '../src/server/reviewServing/reviewServingV4RebuildRequestService.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

type CliOptions = {allActiveProjects: boolean; jsonOutputFile: string | null; projectId: string | null; reason: string}
type RepairProjectFailure = {error: string; projectId: string}
type RepairProjectResult = {failedProjects: RepairProjectFailure[]; requestIds: string[]}

const defaultReason = 'requestJudgmentFactRepair'
const workloadContext = getMaintenanceDuckdbWorkloadContext('requestJudgmentFactRepair')

const writeJson = (value: unknown, options: Pick<CliOptions, 'jsonOutputFile'>) => {
  const output = `${JSON.stringify(value)}\n`

  process.stdout.write(output)

  if (options.jsonOutputFile !== null) {
    writeFileSync(options.jsonOutputFile, output, 'utf8')
  }
}

const quoteSqlString = (value: string) => {
  return `'${value.replaceAll("'", "''")}'`
}

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1).trim()
}

const getCliOptions = (): CliOptions => {
  return {
    allActiveProjects: process.argv.slice(2).includes('--all-active-projects'),
    jsonOutputFile: getArgValue(['--json-output-file', '--output-json']) ?? null,
    projectId: getArgValue(['--projectId', '--project-id']) ?? null,
    reason: getArgValue(['--reason']) ?? defaultReason,
  }
}

const getActiveProjectIds = async () => {
  const rows = await getAppDatabaseService().queryJson<{projectId: string}>(
    `
    SELECT id AS projectId
    FROM app.project
    WHERE archived = FALSE
    ORDER BY id ASC
  `,
    workloadContext,
  )

  return rows.map((row) => {
    return row.projectId
  })
}

const getExplicitProjectIds = async (projectId: string) => {
  const rows = await getAppDatabaseService().queryJson<{projectId: string}>(
    `
    SELECT id AS projectId
    FROM app.project
    WHERE id = ${quoteSqlString(projectId)}
      AND archived = FALSE
  `,
    workloadContext,
  )

  return rows.map((row) => {
    return row.projectId
  })
}

const getRepairProjectIds = async (options: CliOptions) => {
  return options.projectId
    ? getExplicitProjectIds(options.projectId)
    : options.allActiveProjects
      ? getActiveProjectIds()
      : []
}

const getFailureMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const details = String(error)
  const rebuildChunkMessage = details.match(/Review rebuild request [^\n]+ created no rebuild chunks/u)?.[0]

  return rebuildChunkMessage ?? message
}

const getRequestStatus = (result: RepairProjectResult) => {
  return result.failedProjects.length === 0
    ? 'requested'
    : result.requestIds.length === 0
      ? 'failed'
      : 'requested_with_failures'
}

const requestProjectRepairs = async (
  input: {projectIds: string[]; reason: string},
  index = 0,
): Promise<RepairProjectResult> => {
  const projectId = input.projectIds[index]

  if (!projectId) {
    return {failedProjects: [], requestIds: []}
  }

  try {
    const request = await requestReviewServingV4Rebuild({
      components: defaultJudgmentRepairV4RebuildComponents,
      projectId,
      reason: input.reason,
    })
    const remaining = await requestProjectRepairs(input, index + 1)

    return {failedProjects: remaining.failedProjects, requestIds: [request.requestId, ...remaining.requestIds]}
  } catch (error) {
    const failure = {error: getFailureMessage(error), projectId}
    const remaining = await requestProjectRepairs(input, index + 1)

    return {failedProjects: [failure, ...remaining.failedProjects], requestIds: remaining.requestIds}
  }
}

const main = async () => {
  const options = getCliOptions()

  await withDuckdbMaintenanceAccess('request judgment fact repair', async () => {
    const projectIds = await getRepairProjectIds(options)

    if (!options.projectId && !options.allActiveProjects) {
      console.error(
        'Phase 5B retired the implicit mart.judgment_fact duplicate scan. Use --project-id=<project-id> or --all-active-projects to enqueue V4 repair work.',
      )
      writeJson(
        {
          projectIds,
          reason: options.reason,
          requestIds: [],
          requestedCount: 0,
          status: 'requires_project_selection',
        },
        options,
      )
      process.exitCode = 1
      return
    }

    if (projectIds.length === 0) {
      writeJson({projectIds, reason: options.reason, requestIds: [], requestedCount: 0, status: 'not_found'}, options)
      return
    }

    const result = await requestProjectRepairs({projectIds, reason: options.reason})

    writeJson(
      {
        failedCount: result.failedProjects.length,
        failedProjects: result.failedProjects,
        projectIds,
        reason: options.reason,
        requestIds: result.requestIds,
        requestedCount: result.requestIds.length,
        status: getRequestStatus(result),
      },
      options,
    )
  })
}

await main()
