import {Elysia, t} from 'elysia'

import {clearLocalDatabases} from '../services/clearLocalDatabases.ts'
import {getDuckdbRuntimeWorkloadDiagnosticsSnapshot} from '../utils/duckdbService.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {adminInvestigateRoutesGetInvestigateUnexpectedAnswers} from './adminInvestigateRoutes/adminInvestigateRoutesGetInvestigateUnexpectedAnswers.ts'
import {adminInvestigateRoutesGetListPromptsWithTypes} from './adminInvestigateRoutes/adminInvestigateRoutesGetListPromptsWithTypes.ts'
import {adminInvestigateRoutesGetMaintenanceRuntimeDiagnostics} from './adminInvestigateRoutes/adminInvestigateRoutesGetMaintenanceRuntimeDiagnostics.ts'
import {adminInvestigateRoutesGetProcessActivity} from './adminInvestigateRoutes/adminInvestigateRoutesGetProcessActivity.ts'
import {appDatabaseService} from './adminInvestigateRoutes/adminInvestigateRoutesServices.ts'
import {getAutoSyncAllProgress, runAutoSyncAllAsync} from './adminInvestigateRoutes/autoSyncAllUnexpectedAnswers.ts'
import {deleteUnexpectedJudgments} from './adminInvestigateRoutes/deleteUnexpectedJudgments.ts'
import {getWorkerRuntimeDiagnostics} from './adminInvestigateRoutes/getWorkerRuntimeDiagnostics.ts'
import {workerRuntimeDiagnosticsPath} from './adminInvestigateRoutes/workerRuntimeDiagnosticsPath.ts'

export {workerRuntimeDiagnosticsPath} from './adminInvestigateRoutes/workerRuntimeDiagnosticsPath.ts'

export const adminInvestigateRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/admin/duckdb-append-metrics', async () => {
    return appDatabaseService.getAppendMetrics()
  })
  .get('/api/admin/duckdb-runtime-workloads', async () => {
    return getDuckdbRuntimeWorkloadDiagnosticsSnapshot()
  })
  .get('/api/admin/maintenance-runtime-diagnostics', async () => {
    return adminInvestigateRoutesGetMaintenanceRuntimeDiagnostics()
  })
  .get(
    '/api/admin/process-activity',
    ({query}) => {
      return adminInvestigateRoutesGetProcessActivity({query})
    },
    {query: t.Object({limit: t.Optional(t.String())})},
  )
  .post('/api/admin/clear-databases', async () => {
    return {data: await clearLocalDatabases()}
  })
  .get(workerRuntimeDiagnosticsPath, async () => {
    return getWorkerRuntimeDiagnostics()
  })
  .get('/api/admin/list-prompts-with-types', async () => {
    return adminInvestigateRoutesGetListPromptsWithTypes()
  })
  .post(
    '/api/admin/delete-unexpected-answers',
    async ({body}) => {
      return deleteUnexpectedJudgments(body.projectId, body.promptId, body.unexpectedValue)
    },
    {
      body: t.Object({
        projectId: t.Union([t.String(), t.Null()]),
        promptId: t.String(),
        unexpectedValue: t.Union([t.String(), t.Null()]),
      }),
    },
  )
  .post(
    '/api/admin/auto-sync-all-unexpected-answers',
    async ({body}) => {
      return runAutoSyncAllAsync(body?.projectId ?? null)
    },
    {body: t.Optional(t.Object({projectId: t.Optional(t.Union([t.String(), t.Null()]))}))},
  )
  .get('/api/admin/auto-sync-all-progress', async () => {
    return getAutoSyncAllProgress()
  })
  .get(
    '/api/admin/investigate-unexpected-answers',
    async ({query}) => {
      return adminInvestigateRoutesGetInvestigateUnexpectedAnswers({query})
    },
    {query: t.Object({projectId: t.Optional(t.String()), promptId: t.Optional(t.String())})},
  )
