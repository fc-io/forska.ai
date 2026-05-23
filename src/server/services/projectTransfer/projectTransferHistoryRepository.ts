import {randomUUID} from 'node:crypto'

import type {ProjectTransferDirection, ProjectTransferHistoryRecord} from '../../../db/schemaTypes.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import {getJsonValue, getSqlLiteral, getTimestampLiteral} from '../appQueryHelpers.ts'
import type {ProjectTransferCompletionPayload} from './projectTransferSession.ts'

type ProjectTransferHistoryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

type ProjectTransferPayloadCounts = Record<string, number>

type CreateProjectTransferHistoryParams = {
  commitId?: string | null
  completionPayload?: ProjectTransferCompletionPayload | null
  direction: ProjectTransferDirection
  id?: string
  now?: Date
  packageFingerprint: string
  payloadCounts: ProjectTransferPayloadCounts
  runner?: ProjectTransferHistoryRunner
  schemaVersion: number
  sessionId?: string | null
  sourceProjectId?: string | null
  sourceProjectName: string
  targetProjectId?: string | null
  targetProjectName?: string | null
}

type GetProjectTransferHistoryParams = {id: string; runner?: ProjectTransferHistoryRunner}

type FindDuplicateImportHistoryParams = {
  limit?: number
  packageFingerprint: string
  runner?: ProjectTransferHistoryRunner
}

type GetCompletedImportHistoryBySessionParams = {runner?: ProjectTransferHistoryRunner; sessionId: string}

const getRunner = (runner?: ProjectTransferHistoryRunner) => {
  return runner ?? getAppDatabaseService()
}

const getJsonLiteral = (value: unknown) => {
  return value === null || value === undefined ? 'NULL' : `CAST(${getSqlLiteral(JSON.stringify(value))} AS JSON)`
}

const getProjectTransferHistorySelectSql = () => {
  return `
    id,
    direction,
    session_id AS sessionId,
    commit_id AS commitId,
    package_fingerprint AS packageFingerprint,
    CAST(schema_version AS INTEGER) AS schemaVersion,
    source_project_id AS sourceProjectId,
    source_project_name AS sourceProjectName,
    target_project_id AS targetProjectId,
    target_project_name AS targetProjectName,
    TO_JSON(payload_counts_json) AS payloadCountsJson,
    TO_JSON(completion_payload_json) AS completionPayloadJson,
    created_at AS createdAt
  `
}

const mapProjectTransferHistoryRecord = (
  row: Omit<ProjectTransferHistoryRecord, 'completionPayloadJson' | 'payloadCountsJson'> & {
    completionPayloadJson: unknown
    payloadCountsJson: unknown
  },
): ProjectTransferHistoryRecord => {
  return {
    ...row,
    completionPayloadJson: getJsonValue(row.completionPayloadJson),
    payloadCountsJson: getJsonValue(row.payloadCountsJson),
  }
}

const getNonEmptyValue = (value: string | null | undefined) => {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

const isNonNegativeInteger = (value: unknown) => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

const assertNonEmptyValue = (value: string | null | undefined, label: string) => {
  if (getNonEmptyValue(value) === null) {
    throw new Error(`Project transfer history ${label} is required`)
  }
}

const assertPayloadCounts = (payloadCounts: ProjectTransferPayloadCounts) => {
  const invalidKey = Object.keys(payloadCounts).find((key) => {
    return !isNonNegativeInteger(payloadCounts[key])
  })

  if (invalidKey) {
    throw new Error(`Project transfer history payload count ${invalidKey} must be a non-negative integer`)
  }
}

const assertImportHistoryInvariants = (params: CreateProjectTransferHistoryParams) => {
  if (params.direction !== 'import') {
    return
  }

  assertNonEmptyValue(params.sessionId, 'import session id')
  assertNonEmptyValue(params.commitId, 'import commit id')
  assertNonEmptyValue(params.targetProjectId, 'import target project id')
  assertNonEmptyValue(params.targetProjectName, 'import target project name')

  if (params.completionPayload?.status !== 'completed') {
    throw new Error('Project transfer import history completion payload is required')
  }
}

const assertProjectTransferHistoryParams = (params: CreateProjectTransferHistoryParams) => {
  assertNonEmptyValue(params.packageFingerprint, 'package fingerprint')
  assertNonEmptyValue(params.sourceProjectName, 'source project name')
  assertPayloadCounts(params.payloadCounts)
  assertImportHistoryInvariants(params)

  if (!Number.isInteger(params.schemaVersion) || params.schemaVersion <= 0) {
    throw new Error('Project transfer history schema version must be a positive integer')
  }
}

const getProjectTransferHistoryById = async ({id, runner}: GetProjectTransferHistoryParams) => {
  const [row] = await getRunner(runner).queryJson<
    Omit<ProjectTransferHistoryRecord, 'completionPayloadJson' | 'payloadCountsJson'> & {
      completionPayloadJson: unknown
      payloadCountsJson: unknown
    }
  >(`
    SELECT ${getProjectTransferHistorySelectSql()}
    FROM app.project_transfer_history
    WHERE id = ${getSqlLiteral(id)}
    LIMIT 1
  `)

  return row ? mapProjectTransferHistoryRecord(row) : null
}

const getCompletedImportHistoryBySessionId = async ({runner, sessionId}: GetCompletedImportHistoryBySessionParams) => {
  const [row] = await getRunner(runner).queryJson<
    Omit<ProjectTransferHistoryRecord, 'completionPayloadJson' | 'payloadCountsJson'> & {
      completionPayloadJson: unknown
      payloadCountsJson: unknown
    }
  >(`
    SELECT ${getProjectTransferHistorySelectSql()}
    FROM app.project_transfer_history
    WHERE direction = 'import'
      AND session_id = ${getSqlLiteral(sessionId)}
    ORDER BY created_at DESC, id ASC
    LIMIT 1
  `)

  return row ? mapProjectTransferHistoryRecord(row) : null
}

const findDuplicateImportHistoryByPackageFingerprint = async ({
  limit = 20,
  packageFingerprint,
  runner,
}: FindDuplicateImportHistoryParams) => {
  const rows = await getRunner(runner).queryJson<
    Omit<ProjectTransferHistoryRecord, 'completionPayloadJson' | 'payloadCountsJson'> & {
      completionPayloadJson: unknown
      payloadCountsJson: unknown
    }
  >(`
    SELECT ${getProjectTransferHistorySelectSql()}
    FROM app.project_transfer_history
    WHERE direction = 'import'
      AND package_fingerprint = ${getSqlLiteral(packageFingerprint)}
    ORDER BY created_at DESC, id ASC
    LIMIT ${Math.max(0, Math.floor(limit))}
  `)

  return rows.map(mapProjectTransferHistoryRecord)
}

const createProjectTransferHistory = async (params: CreateProjectTransferHistoryParams) => {
  assertProjectTransferHistoryParams(params)

  const runner = getRunner(params.runner)
  const currentNow = params.now ?? new Date()
  const conflictClause = params.direction === 'import' ? 'ON CONFLICT(direction, session_id) DO NOTHING' : ''
  const [row] = await runner.queryJson<
    Omit<ProjectTransferHistoryRecord, 'completionPayloadJson' | 'payloadCountsJson'> & {
      completionPayloadJson: unknown
      payloadCountsJson: unknown
    }
  >(`
    INSERT INTO app.project_transfer_history (
      id,
      direction,
      session_id,
      commit_id,
      package_fingerprint,
      schema_version,
      source_project_id,
      source_project_name,
      target_project_id,
      target_project_name,
      payload_counts_json,
      completion_payload_json,
      created_at
    ) VALUES (
      ${getSqlLiteral(params.id ?? randomUUID())},
      ${getSqlLiteral(params.direction)},
      ${getSqlLiteral(params.sessionId ?? null)},
      ${getSqlLiteral(params.commitId ?? null)},
      ${getSqlLiteral(params.packageFingerprint)},
      ${params.schemaVersion},
      ${getSqlLiteral(params.sourceProjectId ?? null)},
      ${getSqlLiteral(params.sourceProjectName)},
      ${getSqlLiteral(params.targetProjectId ?? null)},
      ${getSqlLiteral(params.targetProjectName ?? null)},
      ${getJsonLiteral(params.payloadCounts)},
      ${getJsonLiteral(params.completionPayload ?? null)},
      ${getTimestampLiteral(currentNow)}
    )
    ${conflictClause}
    RETURNING ${getProjectTransferHistorySelectSql()}
  `)
  const history =
    (row ? mapProjectTransferHistoryRecord(row) : null)
    ?? (params.direction === 'import'
      ? await getCompletedImportHistoryBySessionId({runner, sessionId: params.sessionId ?? ''})
      : null)

  if (!history) {
    throw new Error('Failed to create project transfer history record')
  }

  return history
}

const projectTransferHistoryRepository = {
  createProjectTransferHistory,
  findDuplicateImportHistoryByPackageFingerprint,
  getCompletedImportHistoryBySessionId,
  getProjectTransferHistoryById,
}

export const getProjectTransferHistoryRepository = () => {
  return projectTransferHistoryRepository
}

export type {
  CreateProjectTransferHistoryParams,
  FindDuplicateImportHistoryParams,
  GetCompletedImportHistoryBySessionParams,
  GetProjectTransferHistoryParams,
  ProjectTransferHistoryRunner,
  ProjectTransferPayloadCounts,
}
