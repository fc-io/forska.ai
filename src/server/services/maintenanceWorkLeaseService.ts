import {getMaintenanceDuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getJsonValue, getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'

type MaintenanceWorkScopeKind = 'article' | 'job' | 'project' | 'queue'
type MaintenanceWorkConsumerRole = 'judge-worker' | 'maintenance-worker'
type MaintenanceWorkRecoveryMode = 'archived_project_mart_recovery' | 'none' | 'retry_backoff'
type MaintenanceWorkKind =
  | 'judgment_sqlite_outbox_import'
  | 'review_index_archived_project_recovery'
  | 'review_index_article_refresh'
  | 'review_index_large_rebuild'
  | 'review_index_project_refresh'
  | 'review_index_serving_generation_cleanup'

type MaintenanceWorkLeaseIdentity = {
  articleId?: string | null
  judgmentJobId?: string | null
  projectId?: string | null
  queueId?: string | null
  scopeKind: MaintenanceWorkScopeKind
  workKind: MaintenanceWorkKind
}

type MaintenanceWorkLeaseParams = MaintenanceWorkLeaseIdentity & {
  consumerId: string
  leaseMs: number
  now?: Date
  recoveryContext?: Record<string, unknown> | null
  recoveryMode?: MaintenanceWorkRecoveryMode
  requiredConsumerRole: MaintenanceWorkConsumerRole
  retryAfterAt?: Date | null
}

type CompleteMaintenanceWorkLeaseParams = MaintenanceWorkLeaseIdentity & {consumerId?: string; now?: Date}

type ClearMaintenanceWorkLeasesForProjectParams = {now?: Date; projectId: string}

export type FreshMaintenanceWorkLeaseRecord = {
  articleId: string | null
  consumerId: string | null
  freshUntilAt: string | null
  id: string
  judgmentJobId: string | null
  lastProgressedAt: string | null
  lastStartedAt: string | null
  leaseExpiresAt: string | null
  projectId: string | null
  queueId: string | null
  recoveryContext: Record<string, unknown> | null
  recoveryMode: MaintenanceWorkRecoveryMode
  requiredConsumerRole: MaintenanceWorkConsumerRole
  retryAfterAt: string | null
  scopeKind: MaintenanceWorkScopeKind
  workKind: MaintenanceWorkKind
}

const getNow = (now?: Date) => {
  return now ?? new Date()
}

const maintenanceWorkLeaseWorkloadContext = getMaintenanceDuckdbWorkloadContext('maintenanceWorkLease')

const getFreshUntilAt = ({leaseMs, now}: {leaseMs: number; now: Date}) => {
  return new Date(now.getTime() + leaseMs)
}

const getMaintenanceWorkLeaseId = ({
  articleId,
  judgmentJobId,
  projectId,
  queueId,
  scopeKind,
  workKind,
}: MaintenanceWorkLeaseIdentity) => {
  return [workKind, scopeKind, projectId ?? '', articleId ?? '', queueId ?? '', judgmentJobId ?? ''].join(':')
}

const getRecoveryContextSql = (recoveryContext?: Record<string, unknown> | null) => {
  return recoveryContext === undefined || recoveryContext === null ? 'NULL' : getSqlLiteral(recoveryContext)
}

const getRetryAfterAtSql = (retryAfterAt?: Date | null) => {
  return retryAfterAt === undefined || retryAfterAt === null ? 'NULL' : getTimestampLiteral(retryAfterAt)
}

const mapMaintenanceWorkLeaseRow = (
  row: Omit<FreshMaintenanceWorkLeaseRecord, 'recoveryContext'> & {recoveryContext: unknown},
): FreshMaintenanceWorkLeaseRecord => {
  return {...row, recoveryContext: getJsonValue(row.recoveryContext) as Record<string, unknown> | null}
}

const getMaintenanceWorkLeaseSelectSql = () => {
  return `
    id,
    work_kind AS workKind,
    scope_kind AS scopeKind,
    project_id AS projectId,
    article_id AS articleId,
    queue_id AS queueId,
    judgment_job_id AS judgmentJobId,
    required_consumer_role AS requiredConsumerRole,
    consumer_id AS consumerId,
    last_started_at AS lastStartedAt,
    last_progressed_at AS lastProgressedAt,
    lease_expires_at AS leaseExpiresAt,
    fresh_until_at AS freshUntilAt,
    retry_after_at AS retryAfterAt,
    recovery_mode AS recoveryMode,
    TO_JSON(recovery_context) AS recoveryContext
  `
}

const claimMaintenanceWorkLease = async (params: MaintenanceWorkLeaseParams) => {
  const currentNow = getNow(params.now)
  const freshUntilAt = getFreshUntilAt({leaseMs: params.leaseMs, now: currentNow})
  const id = getMaintenanceWorkLeaseId(params)
  const [row] = await getAppDatabaseService().queryJson<
    Omit<FreshMaintenanceWorkLeaseRecord, 'recoveryContext'> & {recoveryContext: unknown}
  >(
    `
    INSERT INTO app.maintenance_work_lease (
      id,
      work_kind,
      scope_kind,
      project_id,
      article_id,
      queue_id,
      judgment_job_id,
      required_consumer_role,
      consumer_id,
      last_started_at,
      last_progressed_at,
      lease_expires_at,
      fresh_until_at,
      retry_after_at,
      recovery_mode,
      recovery_context,
      completed_at,
      updated_at
    ) VALUES (
      ${getSqlLiteral(id)},
      ${getSqlLiteral(params.workKind)},
      ${getSqlLiteral(params.scopeKind)},
      ${getSqlLiteral(params.projectId ?? null)},
      ${getSqlLiteral(params.articleId ?? null)},
      ${getSqlLiteral(params.queueId ?? null)},
      ${getSqlLiteral(params.judgmentJobId ?? null)},
      ${getSqlLiteral(params.requiredConsumerRole)},
      ${getSqlLiteral(params.consumerId)},
      ${getTimestampLiteral(currentNow)},
      ${getTimestampLiteral(currentNow)},
      ${getTimestampLiteral(freshUntilAt)},
      ${getTimestampLiteral(freshUntilAt)},
      ${getRetryAfterAtSql(params.retryAfterAt)},
      ${getSqlLiteral(params.recoveryMode ?? 'none')},
      ${getRecoveryContextSql(params.recoveryContext)},
      NULL,
      ${getTimestampLiteral(currentNow)}
    )
    ON CONFLICT(id) DO UPDATE SET
      work_kind = EXCLUDED.work_kind,
      scope_kind = EXCLUDED.scope_kind,
      project_id = EXCLUDED.project_id,
      article_id = EXCLUDED.article_id,
      queue_id = EXCLUDED.queue_id,
      judgment_job_id = EXCLUDED.judgment_job_id,
      required_consumer_role = EXCLUDED.required_consumer_role,
      consumer_id = EXCLUDED.consumer_id,
      last_started_at = EXCLUDED.last_started_at,
      last_progressed_at = EXCLUDED.last_progressed_at,
      lease_expires_at = EXCLUDED.lease_expires_at,
      fresh_until_at = EXCLUDED.fresh_until_at,
      retry_after_at = EXCLUDED.retry_after_at,
      recovery_mode = EXCLUDED.recovery_mode,
      recovery_context = EXCLUDED.recovery_context,
      completed_at = NULL,
      updated_at = EXCLUDED.updated_at
    RETURNING ${getMaintenanceWorkLeaseSelectSql()}
  `,
    maintenanceWorkLeaseWorkloadContext,
  )

  return row ? mapMaintenanceWorkLeaseRow(row) : null
}

const progressMaintenanceWorkLease = async (params: MaintenanceWorkLeaseParams) => {
  const currentNow = getNow(params.now)
  const freshUntilAt = getFreshUntilAt({leaseMs: params.leaseMs, now: currentNow})
  const id = getMaintenanceWorkLeaseId(params)
  const [row] = await getAppDatabaseService().queryJson<
    Omit<FreshMaintenanceWorkLeaseRecord, 'recoveryContext'> & {recoveryContext: unknown}
  >(
    `
    UPDATE app.maintenance_work_lease
    SET
      required_consumer_role = ${getSqlLiteral(params.requiredConsumerRole)},
      consumer_id = ${getSqlLiteral(params.consumerId)},
      last_progressed_at = ${getTimestampLiteral(currentNow)},
      lease_expires_at = ${getTimestampLiteral(freshUntilAt)},
      fresh_until_at = ${getTimestampLiteral(freshUntilAt)},
      retry_after_at = ${getRetryAfterAtSql(params.retryAfterAt)},
      recovery_mode = ${getSqlLiteral(params.recoveryMode ?? 'none')},
      recovery_context = ${getRecoveryContextSql(params.recoveryContext)},
      completed_at = NULL,
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE id = ${getSqlLiteral(id)}
    RETURNING ${getMaintenanceWorkLeaseSelectSql()}
  `,
    maintenanceWorkLeaseWorkloadContext,
  )

  return row ? mapMaintenanceWorkLeaseRow(row) : claimMaintenanceWorkLease(params)
}

const completeMaintenanceWorkLease = async (params: CompleteMaintenanceWorkLeaseParams) => {
  const currentNow = getNow(params.now)
  const consumerFilter = params.consumerId === undefined ? '' : `AND consumer_id = ${getSqlLiteral(params.consumerId)}`

  await getAppDatabaseService().run(
    `
    UPDATE app.maintenance_work_lease
    SET
      last_progressed_at = ${getTimestampLiteral(currentNow)},
      lease_expires_at = NULL,
      fresh_until_at = NULL,
      completed_at = ${getTimestampLiteral(currentNow)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE id = ${getSqlLiteral(getMaintenanceWorkLeaseId(params))}
      ${consumerFilter}
  `,
    maintenanceWorkLeaseWorkloadContext,
  )
}

const failMaintenanceWorkLease = async (params: MaintenanceWorkLeaseParams) => {
  const currentNow = getNow(params.now)

  await getAppDatabaseService().run(
    `
    UPDATE app.maintenance_work_lease
    SET
      required_consumer_role = ${getSqlLiteral(params.requiredConsumerRole)},
      consumer_id = ${getSqlLiteral(params.consumerId)},
      last_progressed_at = ${getTimestampLiteral(currentNow)},
      lease_expires_at = NULL,
      fresh_until_at = NULL,
      retry_after_at = ${getRetryAfterAtSql(params.retryAfterAt)},
      recovery_mode = ${getSqlLiteral(params.recoveryMode ?? 'retry_backoff')},
      recovery_context = ${getRecoveryContextSql(params.recoveryContext)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE id = ${getSqlLiteral(getMaintenanceWorkLeaseId(params))}
  `,
    maintenanceWorkLeaseWorkloadContext,
  )
}

const clearMaintenanceWorkLeasesForProject = async ({now, projectId}: ClearMaintenanceWorkLeasesForProjectParams) => {
  const currentNow = getNow(now)

  await getAppDatabaseService().run(
    `
    UPDATE app.maintenance_work_lease
    SET
      lease_expires_at = NULL,
      fresh_until_at = NULL,
      completed_at = ${getTimestampLiteral(currentNow)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE completed_at IS NULL
      AND (
        project_id = ${getSqlLiteral(projectId)}
        OR article_id IN (
          SELECT article_id
          FROM app.project_article
          WHERE project_id = ${getSqlLiteral(projectId)}
          UNION
          SELECT air.article_id
          FROM app.project_import_route pir
          INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
          WHERE pir.project_id = ${getSqlLiteral(projectId)}
        )
      )
  `,
    maintenanceWorkLeaseWorkloadContext,
  )
}

const getFreshProjectMaintenanceWorkLeases = async (projectId: string, now = new Date()) => {
  const rows = await getAppDatabaseService().queryJson<
    Omit<FreshMaintenanceWorkLeaseRecord, 'recoveryContext'> & {recoveryContext: unknown}
  >(
    `
    WITH scoped_article AS (
      SELECT article_id AS articleId
      FROM app.project_article
      WHERE project_id = ${getSqlLiteral(projectId)}
      UNION
      SELECT air.article_id AS articleId
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      WHERE pir.project_id = ${getSqlLiteral(projectId)}
    )
    SELECT ${getMaintenanceWorkLeaseSelectSql()}
    FROM app.maintenance_work_lease lease
    WHERE lease.completed_at IS NULL
      AND lease.fresh_until_at IS NOT NULL
      AND lease.fresh_until_at > ${getTimestampLiteral(now)}
      AND lease.work_kind IN (
        'review_index_project_refresh',
        'review_index_article_refresh',
        'review_index_large_rebuild',
        'review_index_serving_generation_cleanup',
        'review_index_archived_project_recovery'
      )
      AND (
        lease.project_id = ${getSqlLiteral(projectId)}
        OR lease.article_id IN (SELECT articleId FROM scoped_article)
      )
    ORDER BY lease.last_progressed_at DESC NULLS LAST, lease.id ASC
  `,
    maintenanceWorkLeaseWorkloadContext,
  )

  return rows.map(mapMaintenanceWorkLeaseRow)
}

const getProjectMaintenanceRecoveryContext = async (projectId: string, now = new Date()) => {
  const [row] = await getAppDatabaseService().queryJson<
    Omit<FreshMaintenanceWorkLeaseRecord, 'recoveryContext'> & {recoveryContext: unknown}
  >(
    `
    WITH scoped_article AS (
      SELECT article_id AS articleId
      FROM app.project_article
      WHERE project_id = ${getSqlLiteral(projectId)}
      UNION
      SELECT air.article_id AS articleId
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      WHERE pir.project_id = ${getSqlLiteral(projectId)}
    )
    SELECT ${getMaintenanceWorkLeaseSelectSql()}
    FROM app.maintenance_work_lease lease
    WHERE lease.completed_at IS NULL
      AND (
        lease.project_id = ${getSqlLiteral(projectId)}
        OR lease.article_id IN (SELECT articleId FROM scoped_article)
      )
      AND (
        lease.recovery_mode <> 'none'
        OR (lease.retry_after_at IS NOT NULL AND lease.retry_after_at > ${getTimestampLiteral(now)})
      )
    ORDER BY lease.updated_at DESC, lease.id ASC
    LIMIT 1
  `,
    maintenanceWorkLeaseWorkloadContext,
  )

  return row ? mapMaintenanceWorkLeaseRow(row) : null
}

const maintenanceWorkLeaseService = {
  claimMaintenanceWorkLease,
  clearMaintenanceWorkLeasesForProject,
  completeMaintenanceWorkLease,
  failMaintenanceWorkLease,
  getFreshProjectMaintenanceWorkLeases,
  getMaintenanceWorkLeaseId,
  getProjectMaintenanceRecoveryContext,
  progressMaintenanceWorkLease,
}

export const getMaintenanceWorkLeaseService = () => {
  return maintenanceWorkLeaseService
}

export type {
  CompleteMaintenanceWorkLeaseParams,
  MaintenanceWorkConsumerRole,
  MaintenanceWorkKind,
  MaintenanceWorkLeaseIdentity,
  MaintenanceWorkLeaseParams,
  MaintenanceWorkRecoveryMode,
  MaintenanceWorkScopeKind,
}
