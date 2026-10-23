import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSafeCovidencePackageConfig, getSafeStructuredFileImportConfig} from './safeDataSourceImportConfigs.ts'

type AppDatabaseService = ReturnType<typeof getAppDatabaseService>
export type AppTx = Parameters<AppDatabaseService['transaction']>[0] extends (runner: infer T) => Promise<unknown>
  ? T
  : never
export type AppQueryRunner = Pick<AppTx, 'queryJson'>
export type DataSourceRow = {
  id: string
  title: string
  description: string | null
  importRoute: string | null
  cursor: string | null
  lastImportAt: unknown
  itemsAfterLastImport: number | null
  createdAt: unknown
  updatedAt: unknown
  dateFrom: unknown
  dateTo: unknown
  trackingEnabled?: boolean | null
  trackingReconcileScheduleMonths?: unknown
  trackingGranularity?: string | null
  trackingHighWaterCompletedAt?: unknown
  trackingActiveWindowStart?: unknown
  trackingActiveWindowEnd?: unknown
  trackingActiveCursor?: string | null
  trackingLastAttemptAt?: unknown
  trackingLastSuccessAt?: unknown
  trackingNextRunAfter?: unknown
  trackingLastReconciliationCompletedAt?: unknown
  trackingFailureCount?: number | null
  trackingLastError?: string | null
  trackingActiveRunKind?: string | null
  trackingActiveReconciliationAgeMonths?: number | null
  trackingPendingReconciliationCount?: number | null
  archived: boolean
}
type StructuredFileConfig = NonNullable<ReturnType<typeof getSafeStructuredFileImportConfig>>
type CovidencePackageConfig = NonNullable<ReturnType<typeof getSafeCovidencePackageConfig>>
export type DataSourceImportState = {
  covidencePackageConfig: CovidencePackageConfig | null
  immutable: boolean
  linkedProjectId: string | null
  linkedPromptIds: string[]
  reimportable: boolean
  structuredFileConfig: StructuredFileConfig | null
}
