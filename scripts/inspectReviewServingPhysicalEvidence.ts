import {writeFileSync} from 'node:fs'

import {DuckDBInstance} from '@duckdb/node-api'
import {Effect} from 'effect'

import {type AppDatabaseSnapshot, getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getSqlLiteral} from '../src/server/services/appQueryHelpers.ts'
import {createDuckdbSnapshotForCli} from '../src/server/utils/duckdbScriptAccess.ts'
import {getReadOnlyDuckdbRuntimeOptions} from '../src/server/utils/duckdbService.ts'

type ColumnProfile = {
  approxDistinctCount: number | null
  column: string
  nonNullCount: number | null
  nullCount: number | null
  type: string
}
type CliOptions = {
  format: 'json' | 'markdown'
  limit: number
  maxProfileColumns: number
  output: string | null
  projectId: string
}
type EvidenceReport = {
  chunkManifestDiagnosticsReadiness: ChunkManifestDiagnosticsReadinessReport
  dirtyWorkRetentionEvidence: DirtyWorkRetentionEvidenceReport
  filteredCountServingPhysicalEvidence: FilteredCountServingPhysicalEvidenceReport
  generatedAt: string
  hotPayloadProxyEvidence: HotPayloadProxyEvidenceReport
  judgmentDetailPayloadReadiness: JudgmentDetailPayloadReadinessReport
  mode: 'readonly-snapshot'
  options: CliOptions
  projectorWatermarkNullableFieldEvidence: ProjectorWatermarkNullableFieldReport
  rebuildRequestLifecycleFieldEvidence: RebuildRequestLifecycleFieldReport
  rebuildArtifactDispositionEvidence: RebuildArtifactDispositionEvidenceReport
  retentionCleanupEligibility: RetentionCleanupEligibilityReport
  selectedImportStagingPhysicalEvidence: SelectedImportStagingPhysicalEvidenceReport
  selectedImportPayloadSlimmingReadiness: SelectedImportPayloadSlimmingReadinessReport
  summaryRebuildAccumulatorLifecycleEvidence: SummaryRebuildAccumulatorLifecycleEvidenceReport
  summaryContributionServingReadiness: SummaryContributionServingReadinessReport
  snapshotPath: string
  tables: TableEvidence[]
  unassessedQueueServingReadiness: UnassessedQueueServingReadinessReport
}
type QueryRuntime = Awaited<ReturnType<typeof getSnapshotQueryRuntime>>
type ChunkManifestDiagnosticsLifecycleRow = {
  admissionState: string
  budgetJsonNonNullRows: number
  budgetJsonNullRows: number
  diagnosticsJsonNonNullRows: number
  diagnosticsJsonNullRows: number
  rows: number
  status: string
  timingDiagnosticsRows: number
}
type ChunkManifestDiagnosticsProjectionRow = {
  budgetJsonNonNullRows: number
  diagnosticsJsonNonNullRows: number
  projectionComponent: string
  rows: number
  timingDiagnosticsRows: number
}
type ChunkManifestDiagnosticsReadinessReport = {
  budgetJsonNonNullRows: number | null
  budgetJsonNullRows: number | null
  currentProjectRows: number | null
  diagnosticsJsonNonNullRows: number | null
  diagnosticsJsonNullRows: number | null
  error: string | null
  note: string
  rowsByLifecycle: ChunkManifestDiagnosticsLifecycleRow[]
  rowsByProjectionComponent: ChunkManifestDiagnosticsProjectionRow[]
  table: 'app.review_rebuild_chunk_manifest'
  timingDiagnosticsRows: number | null
  verdict: 'not-authorized' | 'blocked'
}
type JudgmentDetailPayloadKindRow = {
  answeredArrayNonNullRows: number
  answeredOriginalNonNullRows: number
  judgmentIdNonNullRows: number
  judgmentPayloadNonNullRows: number
  payloadModelIdNonNullRows: number
  payloadKind: string
  placeholderRows: number
  rows: number
}
type JudgmentDetailPayloadListModeRow = {judgmentPayloadNonNullRows: number; listModeKey: string; rows: number}
type JudgmentDetailPayloadSourceJudgmentEvidence = {currentProjectSourceJudgmentRows: number | null; note: string}
type JudgmentDetailPayloadTopLevelKeyRow = {
  currentProjectRows: number
  globalRows: number
  key: string
  payloadKind: string
}
type JudgmentDetailPayloadReadinessReport = {
  answeredArrayNonNullRows: number | null
  answeredOriginalNonNullRows: number | null
  currentProjectRows: number | null
  error: string | null
  globalRowCount: number | null
  judgmentPayloadNonNullRows: number | null
  judgmentPayloadNullRows: number | null
  note: string
  rowsByListMode: JudgmentDetailPayloadListModeRow[]
  rowsByPayloadKind: JudgmentDetailPayloadKindRow[]
  rowsByPayloadTopLevelKey: JudgmentDetailPayloadTopLevelKeyRow[]
  sourceJudgmentEvidence: JudgmentDetailPayloadSourceJudgmentEvidence
  table: 'mart.review_article_judgment_detail_serving_v4'
  verdict: 'not-authorized' | 'blocked'
}
type ProjectorWatermarkNullableFieldColumnEvidence = {
  column: (typeof projectorWatermarkNullableColumns)[number]
  currentProjectNonNullCount: number | null
  currentProjectNullCount: number | null
  globalNonNullCount: number | null
  globalNullCount: number | null
}
type ProjectorWatermarkNullableFieldReport = {
  columns: ProjectorWatermarkNullableFieldColumnEvidence[]
  currentProjectRows: number | null
  error: string | null
  globalRows: number | null
  note: string
  projectId: string
  rowsByProjectScope: SummaryContributionServingRowCount[]
  rowsBySourcePartition: SummaryContributionServingRowCount[]
  table: 'app.review_serving_projector_watermark'
  verdict: 'not-authorized' | 'blocked'
}
type RetentionCleanupEligibilityTable = {
  activeOrLastKnownGoodSnapshotProtectedRows: number | null
  blockerCounts: RetentionCleanupEligibilityBlockerCount[]
  completedRequestAndSummaryChunkCandidateRows: number | null
  dependentPartialBlockedRows: number | null
  eligibleRows: number | null
  error: string | null
  newestDiagnosticRequestProtectedRows: number | null
  pinnedSnapshotProtectedRows: number | null
  protectedRebuildRequestRows: number | null
  table: string
  totalScopedRows: number | null
}
type RetentionCleanupEligibilityBlockerCount = {category: string; rowCount: number}
type RetentionCleanupEligibilityAggregateRow = Omit<
  RetentionCleanupEligibilityTable,
  'blockerCounts' | 'error' | 'table'
>
type RetentionCleanupEligibilityReport = {note: string; projectId: string; tables: RetentionCleanupEligibilityTable[]}
type DirtyWorkAckKindCount = {ackKind: 'point' | 'synthetic_high_water'; rows: number}
type DirtyWorkBlockerCount = {category: string; rows: number}
type DirtyWorkLaneCount = {
  dirtyKind: string
  projectId: string
  projectionComponent: string
  projectionIdentity: string
  rows: number
  sourcePartition: string
  status: string
}
type DirtyWorkLifecycleCounts = {
  completed: number | null
  failed: number | null
  pending: number | null
  running: number | null
  total: number | null
}
type DirtyWorkRetentionEvidenceReport = {
  ackCounts: DirtyWorkAckKindCount[]
  ackTable: 'app.review_serving_dirty_work_ack'
  blockerCounts: DirtyWorkBlockerCount[]
  completedRowsCoveredByAckAndProjectWatermark: number | null
  dirtyWorkTable: 'app.review_serving_dirty_work'
  error: string | null
  laneCounts: DirtyWorkLaneCount[]
  lifecycleCounts: DirtyWorkLifecycleCounts
  note: string
  projectId: string
  protectedNonCompletedRows: number | null
  verdict: 'not-authorized' | 'blocked'
  watermarkTable: 'app.review_serving_project_dirty_source_watermark'
}
type FilteredCountServingPhysicalEvidenceBucketRow = {
  bucket: 'older-than-7d' | 'older-than-14d' | 'older-than-30d'
  candidateRows: number
  currentProjectCandidateRows: number
}
type FilteredCountServingPhysicalEvidenceGroupStats = {
  avgRowsPerProjectConfigSnapshotListMode: number | null
  maxRowsPerProjectConfigSnapshotListMode: number | null
}
type FilteredCountServingPhysicalEvidenceStatusListModeRow = {
  currentProjectRows: number
  listModeKey: string
  rowCount: number
  snapshotStatus: string
}
type FilteredCountServingPhysicalEvidenceReport = {
  activeOrLastKnownGoodSnapshotProtectedRows: number | null
  currentProjectRows: number | null
  error: string | null
  globalRowCount: number | null
  groupStats: FilteredCountServingPhysicalEvidenceGroupStats
  missingSnapshotManifestRows: number | null
  note: string
  pinnedSnapshotProtectedRows: number | null
  projectId: string
  rowsBySnapshotStatusAndListMode: FilteredCountServingPhysicalEvidenceStatusListModeRow[]
  staleByTtlCandidateCounts: FilteredCountServingPhysicalEvidenceBucketRow[]
  table: 'mart.review_filtered_count_serving_v4'
  totalRowCount: number | null
  verdict: 'not-authorized' | 'blocked'
}
type HotPayloadArrayProxyEvidence = {
  approxStringBytes: number | null
  avgArrayLength: number | null
  column: 'article_ids' | 'prompt_ids'
  currentProjectRows: number | null
  error: string | null
  maxArrayLength: number | null
  rowCount: number | null
  status: 'ok' | 'blocked'
  table: 'mart.review_article_filter_posting_serving_v4' | 'mart.review_unassessed_queue_serving_v4'
  totalArrayMemberships: number | null
}
type HotPayloadScalarProxyEvidence = {
  approxStringBytes: number | null
  column: 'budget_json' | 'diagnostics_json'
  currentProjectRows: number | null
  error: string | null
  nonNullRows: number | null
  rowCount: number | null
  status: 'ok' | 'blocked'
  table: 'app.review_rebuild_chunk_manifest'
}
type HotPayloadProxyEvidenceReport = {
  arrayColumns: HotPayloadArrayProxyEvidence[]
  note: string
  scalarColumns: HotPayloadScalarProxyEvidence[]
  verdict: 'not-authorized' | 'blocked'
}
type RebuildArtifactDispositionArtifactRow = {
  artifactTable: string
  distinctChunks: number
  distinctRequests: number
  requestDisposition: string
  rows: number
}
type RebuildArtifactDispositionRequestRow = {
  chunkRows: number
  requestDisposition: string
  requests: number
  sampleRequestIds: string[]
}
type RebuildArtifactDispositionRequestlessChunkRow = {
  adoptionHint: string
  distinctChunks: number
  partialDependencyRows: number
  rows: number
  summaryRows: number
}
type RebuildArtifactDispositionEvidenceReport = {
  artifactRowsByRequestDisposition: RebuildArtifactDispositionArtifactRow[]
  currentProjectChunkRows: number | null
  error: string | null
  note: string
  projectId: string
  requestRowsByDisposition: RebuildArtifactDispositionRequestRow[]
  requestlessChunkRows: number | null
  requestlessRowsByAdoptionHint: RebuildArtifactDispositionRequestlessChunkRow[]
  table: 'app.review_rebuild_chunk_manifest'
  verdict: 'not-authorized' | 'blocked'
}
type SummaryRebuildAccumulatorBlockerCount = {category: string; rows: number}
type SummaryRebuildAccumulatorLifecycleRow = {
  admissionState: string
  distinctRequests: number
  requestDisposition: string
  requestStatus: string
  rows: number
}
type SummaryRebuildAccumulatorLifecycleEvidenceReport = {
  activeRequestRows: number | null
  admittedRequestRows: number | null
  blockerCounts: SummaryRebuildAccumulatorBlockerCount[]
  completedRequestCandidateRows: number | null
  currentProjectRows: number | null
  error: string | null
  failedRequestCandidateRows: number | null
  globalRows: number | null
  newestDiagnosticRequestProtectedRows: number | null
  note: string
  projectId: string
  protectedRequestRows: number | null
  rowsByRequestLifecycle: SummaryRebuildAccumulatorLifecycleRow[]
  rowsJoinedToCompletedSummaryChunks: number | null
  table: 'mart.review_article_summary_rebuild_accumulator_v4'
  terminalRequestCandidateRows: number | null
  verdict: 'not-authorized' | 'blocked'
}
type RebuildRequestLifecycleFieldColumnEvidence = {
  column: (typeof rebuildRequestLifecycleNullableColumns)[number]
  currentProjectNonNullCount: number | null
  currentProjectNullCount: number | null
  globalNonNullCount: number | null
  globalNullCount: number | null
}
type RebuildRequestLifecycleReasonRow = {
  admissionState: string
  nonNullLifecycleFieldRows: number
  reason: string
  rows: number
  status: string
}
type RebuildRequestLifecycleFieldReport = {
  columns: RebuildRequestLifecycleFieldColumnEvidence[]
  currentProjectRows: number | null
  error: string | null
  globalRows: number | null
  note: string
  projectId: string
  rowsByReasonAndStatus: RebuildRequestLifecycleReasonRow[]
  table: 'app.review_rebuild_request'
  verdict: 'not-authorized' | 'blocked'
}
type SelectedImportPayloadColumnEvidence = {
  column: (typeof selectedImportPayloadColumns)[number]
  hotFieldNonNullCount: number | null
  hotFieldNullCount: number | null
  selectedBaseColumnStatus: 'active' | 'retired/dropped'
  selectedBaseActiveOrLastKnownGoodNonNullCount: number | null
  selectedBaseActiveOrLastKnownGoodNullCount: number | null
  selectedBaseCandidateNonNullCount: number | null
  selectedBaseCandidateNullCount: number | null
  selectedBaseNonNullCount: number | null
  selectedBaseOtherNonNullCount: number | null
  selectedBaseOtherNullCount: number | null
  selectedBaseNullCount: number | null
}
type SelectedImportDisplayCopyGlobalEvidence = {
  activeOrLastKnownGoodRows: number | null
  candidateRows: number | null
  columns: SelectedImportDisplayCopyGlobalColumnEvidence[]
  otherRows: number | null
  rows: SelectedImportDisplayCopyGlobalStatusRow[]
  totalRows: number | null
}
type SelectedImportDisplayCopyGlobalColumnEvidence = {
  column: (typeof selectedImportDisplayCopyColumns)[number]
  nonNullCount: number | null
  nullCount: number | null
  status: 'active' | 'retired/dropped'
}
type SelectedImportDisplayCopyGlobalStatusRow = {
  activeOrLastKnownGoodProtected: boolean
  candidateRows: number
  nonNullCounts: Record<(typeof selectedImportDisplayCopyColumns)[number], number | null>
  nullCounts: Record<(typeof selectedImportDisplayCopyColumns)[number], number | null>
  otherRows: number
  rowCount: number
  snapshotStatus: string
}
type SelectedImportDuplicateConflictGlobalEvidence = {
  activeOrLastKnownGoodRows: number | null
  candidateRows: number | null
  conflictFlagStatus: 'active' | 'retired/dropped'
  hotConflictTrueRows: number | null
  hotDuplicateTrueRows: number | null
  hotResolvedRows: number | null
  missingHotRows: number | null
  note: string
  otherRows: number | null
  duplicateFlagStatus: 'active' | 'retired/dropped'
  rows: SelectedImportDuplicateConflictGlobalStatusRow[]
  selectedBaseConflictTrueRows: number | null
  selectedBaseDuplicateTrueRows: number | null
  selectedBaseFalseOrDefaultConflictRowsWithoutHot: number | null
  selectedBaseFalseOrDefaultDuplicateRowsWithoutHot: number | null
  selectedBaseTrueConflictRowsWithoutHot: number | null
  selectedBaseTrueDuplicateRowsWithoutHot: number | null
  totalRows: number | null
  conflictMismatchRows: number | null
  duplicateMismatchRows: number | null
}
type SelectedImportDuplicateConflictGlobalTotals = {
  activeOrLastKnownGoodRows: number
  candidateRows: number
  conflictMismatchRows: number
  duplicateMismatchRows: number
  hotConflictTrueRows: number
  hotDuplicateTrueRows: number
  hotResolvedRows: number
  missingHotRows: number
  otherRows: number
  selectedBaseConflictTrueRows: number
  selectedBaseDuplicateTrueRows: number
  selectedBaseFalseOrDefaultConflictRowsWithoutHot: number
  selectedBaseFalseOrDefaultDuplicateRowsWithoutHot: number
  selectedBaseTrueConflictRowsWithoutHot: number
  selectedBaseTrueDuplicateRowsWithoutHot: number
  totalRows: number
}
type SelectedImportDuplicateConflictGlobalStatusRow = {
  activeOrLastKnownGoodProtected: boolean
  candidateRows: number
  conflictMismatchRows: number
  duplicateMismatchRows: number
  hotConflictTrueRows: number
  hotDuplicateTrueRows: number
  hotResolvedRows: number
  missingHotRows: number
  otherRows: number
  rowCount: number
  selectedBaseConflictTrueRows: number
  selectedBaseDuplicateTrueRows: number
  selectedBaseFalseOrDefaultConflictRowsWithoutHot: number
  selectedBaseFalseOrDefaultDuplicateRowsWithoutHot: number
  selectedBaseTrueConflictRowsWithoutHot: number
  selectedBaseTrueDuplicateRowsWithoutHot: number
  snapshotStatus: string
}
type SelectedImportPayloadSnapshotStatusRow = {label: string; rowCount: number}
type SelectedImportStagingDuplicateProbe = {
  duplicateCount: number | null
  keyColumns: string[]
  label: string
  sampleRows: Record<string, string | number | null>[]
}
type SelectedImportStagingPublishStateRow = {
  currentProjectRows: number
  publishState: 'published' | 'unpublished'
  rowCount: number
}
type SelectedImportStagingSourcePartitionRow = {
  currentProjectRows: number
  publishedRows: number
  rowCount: number
  sourcePartition: string
  unpublishedRows: number
}
type SelectedImportStagingPhysicalEvidenceReport = {
  currentProjectPublishedRows: number | null
  currentProjectRows: number | null
  currentProjectUnpublishedRows: number | null
  duplicateProbes: SelectedImportStagingDuplicateProbe[]
  error: string | null
  globalPublishedRows: number | null
  globalRowCount: number | null
  globalUnpublishedRows: number | null
  note: string
  projectId: string
  rowsByPublishState: SelectedImportStagingPublishStateRow[]
  rowsBySourcePartition: SelectedImportStagingSourcePartitionRow[]
  table: 'mart.review_selected_article_import_staging_v4'
  verdict: 'not-authorized' | 'blocked'
}
type SelectedImportPayloadSlimmingReadinessReport = {
  activeOrLastKnownGoodSelectedImportRows: number | null
  candidateSelectedImportRows: number | null
  comparisonStatus: string
  consumerWriterStatus: string
  error: string | null
  hotFieldScopedRows: number | null
  note: string
  otherSelectedImportRows: number | null
  projectId: string
  selectedBaseScopedRows: number | null
  selectedImportDuplicateConflictGlobalEvidence: SelectedImportDuplicateConflictGlobalEvidence
  selectedImportDisplayCopyGlobalEvidence: SelectedImportDisplayCopyGlobalEvidence
  rowsBySelectedImportSnapshotStatus: SelectedImportPayloadSnapshotStatusRow[]
  verdict: 'not-authorized' | 'blocked'
  columns: SelectedImportPayloadColumnEvidence[]
}
type SummaryContributionServingDuplicateProbe = {duplicateCount: number | null; keyColumns: string[]; label: string}
type SummaryContributionServingAggregateRecoverability = {
  contributionGroups: number | null
  error: string | null
  finalRows: number | null
  finalRowsMissingContributionGroup: number | null
  matchedFinalRows: number | null
  missingFinalRows: number | null
  mismatchedFinalRows: number | null
  note: string
  summaryKind: 'count' | 'facet'
}
type SummaryContributionServingPartialOverlap = {
  contributionRows: number | null
  error: string | null
  exactCommonColumnOverlapRows: number | null
  note: string
  partialRows: number | null
  partialRowsWithExactCommonContribution: number | null
}
type SummaryContributionServingRowCount = {label: string; rowCount: number}
type SummaryContributionServingProjectRowCount = SummaryContributionServingRowCount & {projectId: string}
type SummaryContributionServingReadinessReport = {
  activeOrLastKnownGoodSnapshotProtectedRows: number | null
  columnCount: number | null
  columns: TableColumn[]
  duplicateProbes: SummaryContributionServingDuplicateProbe[]
  error: string | null
  globalRowCount: number | null
  indexes: unknown[]
  missingSnapshotManifestRows: number | null
  nonzeroProjectCount: number | null
  note: string
  partialRebuildOverlap: SummaryContributionServingPartialOverlap
  pinnedSnapshotRows: number | null
  recoverabilityClassification: string
  recoverabilityComparisons: SummaryContributionServingAggregateRecoverability[]
  rowsByComponentKind: SummaryContributionServingRowCount[]
  rowsByProject: SummaryContributionServingProjectRowCount[]
  rowsBySnapshotStatus: SummaryContributionServingRowCount[]
  rowsBySummaryDefinitionVersion: SummaryContributionServingRowCount[]
  table: 'mart.review_article_summary_contribution_v4'
  topContributionKeys: SummaryContributionServingRowCount[]
  topProjects: {projectId: string; rowCount: number}[]
  verdict: 'retired' | 'not-authorized' | 'blocked'
}
type UnassessedQueueServingConsumerCount = {
  currentProjectRows: number | null
  globalRows: number | null
  label: string
  note: string
}
type UnassessedQueueServingDuplicateProbe = {duplicateCount: number | null; keyColumns: string[]; label: string}
type UnassessedQueueServingPromptNullness = {
  currentProjectNonNullPromptRows: number | null
  currentProjectNullPromptRows: number | null
  globalNonNullPromptRows: number | null
  globalNullPromptRows: number | null
}
type UnassessedQueueServingReadinessReport = {
  activeOrLastKnownGoodSnapshotProtectedRows: number | null
  candidateRows: number | null
  columns: TableColumn[]
  consumerCounts: UnassessedQueueServingConsumerCount[]
  currentProjectRows: number | null
  distinctArticles: number | null
  distinctPromptPairs: number | null
  duplicateProbes: UnassessedQueueServingDuplicateProbe[]
  error: string | null
  globalRowCount: number | null
  indexes: unknown[]
  missingSnapshotManifestRows: number | null
  note: string
  otherRows: number | null
  pinnedSnapshotRows: number | null
  promptNullness: UnassessedQueueServingPromptNullness
  rowsByProject: SummaryContributionServingProjectRowCount[]
  rowsByProtectionAndStatus: UnassessedQueueServingStatusRow[]
  rowsByQueueKind: SummaryContributionServingRowCount[]
  table: 'mart.review_unassessed_queue_serving_v4'
  verdict: 'not-authorized' | 'blocked'
}
type UnassessedQueueServingStatusRow = {
  activeOrLastKnownGoodProtected: boolean
  candidateRows: number
  currentProjectRows: number
  otherRows: number
  pinnedProtected: boolean
  rowCount: number
  snapshotStatus: string
}
type TableColumn = {column_name: string; data_type: string}
type TableEvidence = {
  columnCount: number
  columnProfiles: ColumnProfile[]
  duplicateProbe: {duplicateCount: number | null; keyColumns: string[]; sql: string | null}
  error: string | null
  indexes: unknown[]
  oldestNewest: Record<string, {max: string | null; min: string | null}>
  rowCount: number | null
  sizeProxies: Record<string, number | null>
  table: string
  whereClause: string | null
}

const defaultProjectId = '7dfb4dd5-d2fe-4b21-b626-7ab26953f6ac'
const defaultLimit = 25
const defaultMaxProfileColumns = 18

const hotReviewServingTables = [
  'mart.review_selected_article_import_current_v4',
  'mart.review_selected_article_import_staging_v4',
  'app.review_selected_import_snapshot',
  'app.review_projection_identity_manifest',
  'app.review_serving_snapshot_manifest',
  'app.review_serving_dirty_work',
  'app.review_serving_projector_watermark',
  'app.review_rebuild_request',
  'app.review_rebuild_chunk_manifest',
  'app.review_serving_retention_mark',
  'mart.review_article_filter_posting_serving_v4',
  'mart.review_article_judgment_detail_serving_v4',
  'mart.review_article_count_serving_v4',
  'mart.review_filtered_count_serving_v4',
  'mart.review_filter_facet_serving_v4',
  'mart.review_filter_option_serving_v4',
  'mart.review_title_search_serving_v4',
  'mart.review_unassessed_queue_serving_v4',
  'mart.review_article_summary_rebuild_accumulator_v4',
] as const

const preferredProfileColumns = [
  'project_id',
  'review_config_hash',
  'snapshot_id',
  'selected_import_snapshot_id',
  'projection_component',
  'status',
  'admission_state',
  'list_mode_key',
  'filter_kind',
  'filter_value',
  'queue_kind',
  'payload_kind',
  'article_id',
  'prompt_id',
  'prompt_ids',
  'request_id',
  'chunk_id',
  'source_chunk_ids_key',
  'sort_key',
  'activity_sort_at',
  'updated_at',
  'accumulator_updated_at',
] as const

const timestampColumnCandidates = [
  'created_at',
  'updated_at',
  'started_at',
  'completed_at',
  'failed_at',
  'activated_at',
  'retired_at',
  'last_progressed_at',
  'lease_expires_at',
  'sort_key',
  'activity_sort_at',
] as const

const duplicateKeyCandidates: Record<string, string[]> = {
  'app.review_rebuild_chunk_manifest': ['chunk_id'],
  'mart.review_selected_article_import_current_v4': [
    'project_id',
    'project_scope_identity',
    'selected_import_snapshot_id',
    'article_id',
  ],
  'mart.review_selected_article_import_staging_v4': ['staging_row_id'],
  'app.review_serving_snapshot_manifest': ['project_id', 'snapshot_id'],
  'mart.review_article_count_serving_v4': [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'list_mode_key',
    'count_kind',
    'filter_key',
  ],
  'mart.review_filtered_count_serving_v4': [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'list_mode_key',
    'filter_signature',
    'component_identity',
  ],
  'mart.review_article_filter_posting_serving_v4': [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'filter_kind',
    'filter_value',
    'list_mode_key',
  ],
  'mart.review_article_judgment_detail_serving_v4': [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'article_id',
    'payload_kind',
    'prompt_id',
  ],
  'mart.review_article_summary_contribution_v4': [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'article_id',
    'component_kind',
    'summary_definition_version',
    'contribution_key',
  ],
  'mart.review_article_summary_rebuild_accumulator_v4': [
    'request_id',
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'summary_kind',
    'summary_identity',
    'list_mode_key',
    'count_kind',
    'filter_key',
    'facet_kind',
    'facet_key',
    'facet_value',
  ],
  'mart.review_filter_facet_serving_v4': [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'summary_identity',
    'facet_kind',
    'facet_key',
    'facet_value',
  ],
  'mart.review_filter_option_serving_v4': [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'search_identity',
    'filter_kind',
    'facet_key',
    'option_value_key',
  ],
  'mart.review_title_search_serving_v4': [
    'project_id',
    'search_identity',
    'project_scope_identity',
    'snapshot_id',
    'token',
  ],
  'mart.review_unassessed_queue_serving_v4': [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'queue_kind',
    'priority_bucket',
    'activity_sort_at',
    'article_id',
  ],
}

const retentionCleanupEligibilityTables = ['app.review_rebuild_chunk_manifest'] as const

const selectedImportPayloadColumns = [
  'import_route_id',
  'source_record_key',
  'selected_rank_key',
  'selected_rank_numeric',
  'publication_year',
  'article_title',
  'journal_title',
  'external_id',
] as const

const selectedImportDisplayCopyColumns = ['publication_year', 'article_title', 'journal_title', 'external_id'] as const

const projectorWatermarkNullableColumns = ['project_id', 'import_route_id'] as const

const rebuildRequestLifecycleNullableColumns = [
  'retry_after',
  'oom_category',
  'over_budget_reason',
  'lease_owner',
  'lease_expires_at',
] as const

const getNullSelectedBaseColumnExpressions = (column: string) => {
  return `NULL::BIGINT AS selectedBase_${column}_nullCount,
        NULL::BIGINT AS selectedBase_${column}_nonNullCount,
        NULL::BIGINT AS selectedBase_${column}_activeOrLastKnownGoodNullCount,
        NULL::BIGINT AS selectedBase_${column}_activeOrLastKnownGoodNonNullCount,
        NULL::BIGINT AS selectedBase_${column}_candidateNullCount,
        NULL::BIGINT AS selectedBase_${column}_candidateNonNullCount,
        NULL::BIGINT AS selectedBase_${column}_otherNullCount,
        NULL::BIGINT AS selectedBase_${column}_otherNonNullCount`
}

const getSelectedBaseColumnExpressions = (column: string, presentColumns: ReadonlySet<string>) => {
  if (!presentColumns.has(column)) {
    return getNullSelectedBaseColumnExpressions(column)
  }

  return `CAST(COUNT(*) FILTER (WHERE selected_base.${column} IS NULL) AS BIGINT) AS selectedBase_${column}_nullCount,
        CAST(COUNT(*) FILTER (WHERE selected_base.${column} IS NOT NULL) AS BIGINT) AS selectedBase_${column}_nonNullCount,
        CAST(COUNT(*) FILTER (WHERE selected_base.protection_bucket = 'active-or-last-known-good' AND selected_base.${column} IS NULL) AS BIGINT) AS selectedBase_${column}_activeOrLastKnownGoodNullCount,
        CAST(COUNT(*) FILTER (WHERE selected_base.protection_bucket = 'active-or-last-known-good' AND selected_base.${column} IS NOT NULL) AS BIGINT) AS selectedBase_${column}_activeOrLastKnownGoodNonNullCount,
        CAST(COUNT(*) FILTER (WHERE selected_base.protection_bucket = 'candidate' AND selected_base.${column} IS NULL) AS BIGINT) AS selectedBase_${column}_candidateNullCount,
        CAST(COUNT(*) FILTER (WHERE selected_base.protection_bucket = 'candidate' AND selected_base.${column} IS NOT NULL) AS BIGINT) AS selectedBase_${column}_candidateNonNullCount,
        CAST(COUNT(*) FILTER (WHERE selected_base.protection_bucket = 'other' AND selected_base.${column} IS NULL) AS BIGINT) AS selectedBase_${column}_otherNullCount,
        CAST(COUNT(*) FILTER (WHERE selected_base.protection_bucket = 'other' AND selected_base.${column} IS NOT NULL) AS BIGINT) AS selectedBase_${column}_otherNonNullCount`
}

const getGlobalDisplayCopyExpressions = (
  column: (typeof selectedImportDisplayCopyColumns)[number],
  presentColumns: ReadonlySet<string>,
) => {
  if (!presentColumns.has(column)) {
    return `NULL::BIGINT AS ${column}_nullCount,
        NULL::BIGINT AS ${column}_nonNullCount`
  }

  return `CAST(COUNT(*) FILTER (WHERE selected_base.${column} IS NULL) AS BIGINT) AS ${column}_nullCount,
        CAST(COUNT(*) FILTER (WHERE selected_base.${column} IS NOT NULL) AS BIGINT) AS ${column}_nonNullCount`
}

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1).trim()
}

const getPositiveIntegerOption = (value: string | undefined, fallback: number) => {
  const parsedValue = value === undefined ? Number.NaN : Number(value)
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback
}

const getCliOptions = (): CliOptions => {
  const format = getArgValue(['--format']) === 'json' ? 'json' : 'markdown'

  return {
    format,
    limit: getPositiveIntegerOption(getArgValue(['--limit']), defaultLimit),
    maxProfileColumns: getPositiveIntegerOption(
      getArgValue(['--max-profile-columns', '--maxProfileColumns']),
      defaultMaxProfileColumns,
    ),
    output: getArgValue(['--output']) ?? null,
    projectId: getArgValue(['--project-id', '--projectId']) ?? defaultProjectId,
  }
}

const deleteSnapshot = (snapshot: AppDatabaseSnapshot) => {
  return Effect.tryPromise(() => {
    return getAppDatabaseService().deleteSnapshot(snapshot.snapshotPath)
  }).pipe(
    Effect.catchAll((error) => {
      return Effect.sync(() => {
        console.error('[inspectReviewServingPhysicalEvidence] failed to delete snapshot', {
          error,
          snapshotPath: snapshot.snapshotPath,
        })
      })
    }),
  )
}

const getSnapshotQueryRuntime = async (snapshotPath: string) => {
  const duckdbInstance = await DuckDBInstance.create(snapshotPath, getReadOnlyDuckdbRuntimeOptions())
  const connection = await duckdbInstance.connect()

  return {connection, duckdbInstance}
}

const closeSnapshotQueryRuntime = (runtime: QueryRuntime) => {
  return Effect.sync(() => {
    runtime.connection.closeSync()
    runtime.duckdbInstance.closeSync()
  })
}

const runReadonlyQuery = async <T>(runtime: QueryRuntime, sql: string): Promise<T[]> => {
  const reader = await runtime.connection.runAndReadAll(sql)
  return reader.getRowObjectsJson() as T[]
}

const getTableParts = (table: string) => {
  const [schemaName, tableName] = table.split('.')

  if (!schemaName || !tableName) {
    throw new Error(`Invalid table name: ${table}`)
  }

  return {schemaName, tableName}
}

const getTableColumns = async (runtime: QueryRuntime, table: string) => {
  const {schemaName, tableName} = getTableParts(table)

  return runReadonlyQuery<TableColumn>(
    runtime,
    `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = ${getSqlLiteral(schemaName)}
        AND table_name = ${getSqlLiteral(tableName)}
      ORDER BY ordinal_position
    `,
  )
}

const getWhereClause = (columns: TableColumn[], projectId: string) => {
  return columns.some((column) => {
    return column.column_name === 'project_id'
  })
    ? `project_id = ${getSqlLiteral(projectId)}`
    : null
}

const hasColumn = (columns: TableColumn[], columnName: string) => {
  return columns.some((column) => {
    return column.column_name === columnName
  })
}

const getRowCount = async (runtime: QueryRuntime, table: string, whereClause: string | null) => {
  const rows = await runReadonlyQuery<{rowCount: number | string}>(
    runtime,
    `SELECT CAST(COUNT(*) AS BIGINT) AS rowCount FROM ${table}${whereClause ? ` WHERE ${whereClause}` : ''}`,
  )
  return Number(rows[0]?.rowCount ?? 0)
}

const getProfileColumns = (columns: TableColumn[], maxProfileColumns: number) => {
  const preferred = preferredProfileColumns.flatMap((columnName) => {
    const column = columns.find((candidate) => {
      return candidate.column_name === columnName
    })

    return column ? [column] : []
  })
  const remaining = columns.filter((column) => {
    return !preferred.some((candidate) => {
      return candidate.column_name === column.column_name
    })
  })

  return [...preferred, ...remaining].slice(0, maxProfileColumns)
}

const getColumnProfile = async (
  runtime: QueryRuntime,
  table: string,
  column: TableColumn,
  whereClause: string | null,
): Promise<ColumnProfile> => {
  const columnSql = `"${column.column_name}"`
  const rows = await runReadonlyQuery<{
    approxDistinctCount: number | string | null
    nonNullCount: number | string | null
    nullCount: number | string | null
  }>(
    runtime,
    `
      SELECT
        CAST(SUM(CASE WHEN ${columnSql} IS NULL THEN 1 ELSE 0 END) AS BIGINT) AS nullCount,
        CAST(SUM(CASE WHEN ${columnSql} IS NOT NULL THEN 1 ELSE 0 END) AS BIGINT) AS nonNullCount,
        CAST(approx_count_distinct(${columnSql}) AS BIGINT) AS approxDistinctCount
      FROM ${table}
      ${whereClause ? `WHERE ${whereClause}` : ''}
    `,
  )
  const row = rows[0]

  return {
    approxDistinctCount: row?.approxDistinctCount === null ? null : Number(row?.approxDistinctCount ?? 0),
    column: column.column_name,
    nonNullCount: row?.nonNullCount === null ? null : Number(row?.nonNullCount ?? 0),
    nullCount: row?.nullCount === null ? null : Number(row?.nullCount ?? 0),
    type: column.data_type,
  }
}

const getOldestNewest = async (
  runtime: QueryRuntime,
  table: string,
  columns: TableColumn[],
  whereClause: string | null,
) => {
  const timestampColumns = timestampColumnCandidates.filter((columnName) => {
    return hasColumn(columns, columnName)
  })
  const result: Record<string, {max: string | null; min: string | null}> = {}

  for (const columnName of timestampColumns) {
    const rows = await runReadonlyQuery<{maxValue: string | null; minValue: string | null}>(
      runtime,
      `
        SELECT MIN("${columnName}") AS minValue, MAX("${columnName}") AS maxValue
        FROM ${table}
        ${whereClause ? `WHERE ${whereClause}` : ''}
      `,
    )
    result[columnName] = {max: rows[0]?.maxValue ?? null, min: rows[0]?.minValue ?? null}
  }

  return result
}

const getIndexes = async (runtime: QueryRuntime, table: string) => {
  const {schemaName, tableName} = getTableParts(table)

  try {
    return await runReadonlyQuery<unknown>(
      runtime,
      `
        SELECT index_name, sql
        FROM duckdb_indexes()
        WHERE schema_name = ${getSqlLiteral(schemaName)}
          AND table_name = ${getSqlLiteral(tableName)}
        ORDER BY index_name
      `,
    )
  } catch {
    return []
  }
}

const getTableExists = async (runtime: QueryRuntime, table: string) => {
  const {schemaName, tableName} = getTableParts(table)
  const rows = await runReadonlyQuery<{tableCount: number | string}>(
    runtime,
    `
      SELECT CAST(COUNT(*) AS BIGINT) AS tableCount
      FROM information_schema.tables
      WHERE table_schema = ${getSqlLiteral(schemaName)}
        AND table_name = ${getSqlLiteral(tableName)}
    `,
  )

  return Number(rows[0]?.tableCount ?? 0) > 0
}

const getSizeProxies = async (
  runtime: QueryRuntime,
  table: string,
  columns: TableColumn[],
  whereClause: string | null,
) => {
  const expressions = columns
    .filter((column) => {
      return (
        column.column_name.endsWith('_json')
        || column.column_name.endsWith('_payload')
        || column.column_name === 'payload'
      )
    })
    .slice(0, 8)
    .map((column) => {
      return `SUM(length(CAST("${column.column_name}" AS VARCHAR))) AS "${column.column_name}_stringBytes"`
    })

  if (expressions.length === 0) {
    return {}
  }

  const rows = await runReadonlyQuery<Record<string, number | string | null>>(
    runtime,
    `
      SELECT ${expressions.join(', ')}
      FROM ${table}
      ${whereClause ? `WHERE ${whereClause}` : ''}
    `,
  )
  const row = rows[0] ?? {}

  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      return [key, value === null ? null : Number(value)]
    }),
  )
}

const getDuplicateProbe = async (
  runtime: QueryRuntime,
  table: string,
  columns: TableColumn[],
  whereClause: string | null,
) => {
  const keyColumns = (duplicateKeyCandidates[table] ?? []).filter((columnName) => {
    return hasColumn(columns, columnName)
  })

  if (keyColumns.length === 0) {
    return {duplicateCount: null, keyColumns, sql: null}
  }

  const keySql = keyColumns
    .map((columnName) => {
      return `"${columnName}"`
    })
    .join(', ')
  const sql = `
    WITH duplicate_keys AS (
      SELECT ${keySql}
      FROM ${table}
      ${whereClause ? `WHERE ${whereClause}` : ''}
      GROUP BY ${keySql}
      HAVING COUNT(*) > 1
    )
    SELECT CAST(COUNT(*) AS BIGINT) AS duplicateCount
    FROM duplicate_keys
  `
  const rows = await runReadonlyQuery<{duplicateCount: number | string}>(runtime, sql)

  return {duplicateCount: Number(rows[0]?.duplicateCount ?? 0), keyColumns, sql}
}

const getHotPayloadArrayProxyEvidence = async (
  runtime: QueryRuntime,
  table: HotPayloadArrayProxyEvidence['table'],
  column: HotPayloadArrayProxyEvidence['column'],
  projectId: string,
): Promise<HotPayloadArrayProxyEvidence> => {
  const blocked = (error: string): HotPayloadArrayProxyEvidence => {
    return {
      approxStringBytes: null,
      avgArrayLength: null,
      column,
      currentProjectRows: null,
      error,
      maxArrayLength: null,
      rowCount: null,
      status: 'blocked',
      table,
      totalArrayMemberships: null,
    }
  }

  try {
    if (!(await getTableExists(runtime, table))) {
      return blocked(`Table is absent: ${table}`)
    }

    const columns = await getTableColumns(runtime, table)

    if (!hasColumn(columns, column)) {
      return blocked(`Missing required evidence column: ${column}`)
    }

    const rows = await runReadonlyQuery<{
      approxStringBytes: number | string | null
      avgArrayLength: number | string | null
      currentProjectRows: number | string
      maxArrayLength: number | string | null
      rowCount: number | string
      totalArrayMemberships: number | string | null
    }>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) AS BIGINT) AS rowCount,
          CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows,
          CAST(COALESCE(SUM(COALESCE(array_length("${column}"), 0)), 0) AS BIGINT) AS totalArrayMemberships,
          CAST(MAX(COALESCE(array_length("${column}"), 0)) AS BIGINT) AS maxArrayLength,
          AVG(COALESCE(array_length("${column}"), 0)) AS avgArrayLength,
          CAST(COALESCE(SUM(length(CAST("${column}" AS VARCHAR))), 0) AS BIGINT) AS approxStringBytes
        FROM ${table}
      `,
    )
    const row = rows[0]

    return {
      approxStringBytes: getNumberOrNull(row?.approxStringBytes),
      avgArrayLength: getNumberOrNull(row?.avgArrayLength),
      column,
      currentProjectRows: getNumberOrNull(row?.currentProjectRows),
      error: null,
      maxArrayLength: getNumberOrNull(row?.maxArrayLength),
      rowCount: getNumberOrNull(row?.rowCount),
      status: 'ok',
      table,
      totalArrayMemberships: getNumberOrNull(row?.totalArrayMemberships),
    }
  } catch (error) {
    return blocked(error instanceof Error ? error.message : String(error))
  }
}

const getHotPayloadScalarProxyEvidence = async (
  runtime: QueryRuntime,
  table: HotPayloadScalarProxyEvidence['table'],
  column: HotPayloadScalarProxyEvidence['column'],
  projectId: string,
): Promise<HotPayloadScalarProxyEvidence> => {
  const blocked = (error: string): HotPayloadScalarProxyEvidence => {
    return {
      approxStringBytes: null,
      column,
      currentProjectRows: null,
      error,
      nonNullRows: null,
      rowCount: null,
      status: 'blocked',
      table,
    }
  }

  try {
    if (!(await getTableExists(runtime, table))) {
      return blocked(`Table is absent: ${table}`)
    }

    const columns = await getTableColumns(runtime, table)

    if (!hasColumn(columns, column)) {
      return blocked(`Missing required evidence column: ${column}`)
    }

    const rows = await runReadonlyQuery<{
      approxStringBytes: number | string | null
      currentProjectRows: number | string
      nonNullRows: number | string
      rowCount: number | string
    }>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) AS BIGINT) AS rowCount,
          CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows,
          CAST(COUNT(*) FILTER (WHERE "${column}" IS NOT NULL) AS BIGINT) AS nonNullRows,
          CAST(COALESCE(SUM(length(CAST("${column}" AS VARCHAR))), 0) AS BIGINT) AS approxStringBytes
        FROM ${table}
      `,
    )
    const row = rows[0]

    return {
      approxStringBytes: getNumberOrNull(row?.approxStringBytes),
      column,
      currentProjectRows: getNumberOrNull(row?.currentProjectRows),
      error: null,
      nonNullRows: getNumberOrNull(row?.nonNullRows),
      rowCount: getNumberOrNull(row?.rowCount),
      status: 'ok',
      table,
    }
  } catch (error) {
    return blocked(error instanceof Error ? error.message : String(error))
  }
}

const getHotPayloadProxyEvidenceReport = async (
  runtime: QueryRuntime,
  projectId: string,
): Promise<HotPayloadProxyEvidenceReport> => {
  const arrayColumns = [
    await getHotPayloadArrayProxyEvidence(
      runtime,
      'mart.review_article_filter_posting_serving_v4',
      'article_ids',
      projectId,
    ),
    await getHotPayloadArrayProxyEvidence(runtime, 'mart.review_unassessed_queue_serving_v4', 'prompt_ids', projectId),
  ]
  const scalarColumns = [
    await getHotPayloadScalarProxyEvidence(runtime, 'app.review_rebuild_chunk_manifest', 'diagnostics_json', projectId),
    await getHotPayloadScalarProxyEvidence(runtime, 'app.review_rebuild_chunk_manifest', 'budget_json', projectId),
  ]

  return {
    arrayColumns,
    note: 'Read-only proof-only hot payload proxy evidence for active post-stack storage candidates. Row, array-membership, and approximate string-byte proxies are physical-shape evidence only; they are not deletion authorization, field-slimming authorization, migration authorization, or runtime cleanup authorization.',
    scalarColumns,
    verdict: [...arrayColumns, ...scalarColumns].every((proxy) => {
      return proxy.status === 'blocked'
    })
      ? 'blocked'
      : 'not-authorized',
  }
}

const getActivePinPredicate = () => {
  return 'pin.released_at IS NULL AND pin.ref_count > 0 AND pin.expires_at > current_timestamp'
}

const getActiveSnapshotManifestGuardPredicate = (snapshotColumn: string) => {
  return `EXISTS (
            SELECT 1
            FROM app.review_serving_snapshot_manifest active_manifest
            WHERE active_manifest.project_id = candidate.project_id
              AND active_manifest.snapshot_status = 'active'
              AND (
                active_manifest.snapshot_id = candidate.${snapshotColumn}
                OR active_manifest.last_known_good_snapshot_id = candidate.${snapshotColumn}
                OR active_manifest.selected_import_snapshot_id = candidate.${snapshotColumn}
              )
          )`
}

const getActiveSnapshotPinGuardPredicate = (snapshotColumn: string) => {
  return `EXISTS (
            SELECT 1
            FROM app.review_serving_snapshot_pin pin
            WHERE pin.project_id = candidate.project_id
              AND pin.snapshot_id = candidate.${snapshotColumn}
              AND ${getActivePinPredicate()}
          )`
}

const getProtectedRebuildRequestPredicate = (requestSource: string) => {
  return `EXISTS (
            SELECT 1
            FROM app.review_rebuild_request protected_request
            WHERE protected_request.request_id = ${requestSource}.request_id
              AND protected_request.project_id = ${requestSource}.project_id
              AND (
                protected_request.status IN (
                  'pending_admission',
                  'admitted',
                  'running',
                  'blocked_over_budget',
                  'quarantined'
                )
                OR protected_request.admission_state IN ('pending', 'blocked_over_budget')
                OR (
                  protected_request.status = 'failed'
                  AND protected_request.admission_state = 'admitted'
                  AND (
                    protected_request.retry_after IS NULL
                    OR protected_request.retry_after <= current_timestamp
                  )
                  AND EXISTS (
                    SELECT 1
                    FROM app.review_rebuild_chunk_manifest retryable_chunk
                    WHERE retryable_chunk.request_id = protected_request.request_id
                      AND retryable_chunk.status = 'failed'
                      AND COALESCE(retryable_chunk.retry_count, 0) < COALESCE(
                        GREATEST(
                          1,
                          TRY_CAST(json_extract_string(protected_request.retry_policy_json, '$.maxAttempts') AS INTEGER)
                        ),
                        3
                      )
                  )
                )
              )
          )`
}

const getNewestDiagnosticRebuildRequestPredicate = (requestSource: string) => {
  return `EXISTS (
            SELECT 1
            FROM app.review_rebuild_request diagnostic_request
            WHERE diagnostic_request.request_id = ${requestSource}.request_id
              AND diagnostic_request.project_id = ${requestSource}.project_id
              AND diagnostic_request.status IN ('failed', 'blocked_over_budget', 'quarantined')
              AND NOT EXISTS (
                SELECT 1
                FROM app.review_rebuild_request newer_diagnostic_request
                WHERE newer_diagnostic_request.project_id = diagnostic_request.project_id
                  AND newer_diagnostic_request.status IN ('failed', 'blocked_over_budget', 'quarantined')
                  AND (
                    newer_diagnostic_request.updated_at > diagnostic_request.updated_at
                    OR (
                      newer_diagnostic_request.updated_at = diagnostic_request.updated_at
                      AND newer_diagnostic_request.request_id > diagnostic_request.request_id
                    )
                  )
              )
          )`
}

const getTerminalRebuildChunkPredicate = (chunkSource: string) => {
  return `${chunkSource}.status = 'completed'
          AND ${chunkSource}.admission_state = 'admitted'`
}

const getManifestReviewConfigHashPredicate = () => {
  return `EXISTS (
            SELECT 1
            FROM app.review_serving_snapshot_manifest cleanup_snapshot
            WHERE cleanup_snapshot.project_id = candidate.project_id
              AND cleanup_snapshot.snapshot_id = candidate.snapshot_id
          )`
}

const getRetentionCleanupBlockerCategorySql = (
  table: (typeof retentionCleanupEligibilityTables)[number],
  projectId: string,
) => {
  const projectPredicate = `candidate.project_id = ${getSqlLiteral(projectId)}`
  const activeSnapshotPredicate = getActiveSnapshotManifestGuardPredicate('snapshot_id')
  const activePinPredicate = getActiveSnapshotPinGuardPredicate('snapshot_id')
  const protectedRequestPredicate = getProtectedRebuildRequestPredicate('request')
  const newestDiagnosticPredicate = getNewestDiagnosticRebuildRequestPredicate('request')

  return `
    WITH classified AS (
      SELECT
        CASE
          WHEN ${activeSnapshotPredicate} THEN 'active_or_last_known_good_snapshot_protected'
          WHEN ${activePinPredicate} THEN 'pinned_snapshot_protected'
          WHEN candidate.request_id IS NULL THEN 'missing_request_id'
          WHEN candidate.snapshot_id IS NULL THEN 'missing_snapshot_id'
          WHEN candidate.projection_component IS DISTINCT FROM 'summary' THEN 'not_summary_chunk'
          WHEN NOT (${getManifestReviewConfigHashPredicate()}) THEN 'missing_snapshot_manifest'
          WHEN request.request_id IS NULL THEN 'missing_rebuild_request'
          WHEN ${protectedRequestPredicate} THEN 'protected_rebuild_request'
          WHEN ${newestDiagnosticPredicate} THEN 'newest_diagnostic_request'
          WHEN request.status IS DISTINCT FROM 'completed' OR request.admission_state IS DISTINCT FROM 'admitted' THEN 'request_not_completed_admitted'
          WHEN candidate.status IS DISTINCT FROM 'completed' OR candidate.admission_state IS DISTINCT FROM 'admitted' THEN 'chunk_not_completed_admitted'
          ELSE 'eligible'
        END AS category
      FROM ${table} candidate
      LEFT JOIN app.review_rebuild_request request
        ON request.request_id = candidate.request_id
        AND request.project_id = candidate.project_id
      WHERE ${projectPredicate}
    )
    SELECT category, CAST(COUNT(*) AS BIGINT) AS rowCount
    FROM classified
    GROUP BY category
    ORDER BY rowCount DESC, category
  `
}

const getRetentionCleanupEligibilitySql = (
  table: (typeof retentionCleanupEligibilityTables)[number],
  projectId: string,
) => {
  const projectPredicate = `candidate.project_id = ${getSqlLiteral(projectId)}`
  const activeSnapshotPredicate = getActiveSnapshotManifestGuardPredicate('snapshot_id')
  const activePinPredicate = getActiveSnapshotPinGuardPredicate('snapshot_id')
  const protectedRequestPredicate = getProtectedRebuildRequestPredicate('request')
  const newestDiagnosticPredicate = getNewestDiagnosticRebuildRequestPredicate('request')

  const terminalCandidatePredicate = `candidate.request_id IS NOT NULL
        AND candidate.snapshot_id IS NOT NULL
        AND candidate.projection_component = 'summary'
        AND ${getManifestReviewConfigHashPredicate()}
        AND request.status = 'completed'
        AND request.admission_state = 'admitted'
        AND ${getTerminalRebuildChunkPredicate('candidate')}`

  return `
    SELECT
      CAST(COUNT(*) AS BIGINT) AS totalScopedRows,
      CAST(COUNT(*) FILTER (WHERE ${activeSnapshotPredicate}) AS BIGINT) AS activeOrLastKnownGoodSnapshotProtectedRows,
      CAST(COUNT(*) FILTER (WHERE ${activePinPredicate}) AS BIGINT) AS pinnedSnapshotProtectedRows,
      CAST(COUNT(*) FILTER (WHERE ${terminalCandidatePredicate}) AS BIGINT) AS completedRequestAndSummaryChunkCandidateRows,
      CAST(COUNT(*) FILTER (WHERE ${protectedRequestPredicate}) AS BIGINT) AS protectedRebuildRequestRows,
      CAST(COUNT(*) FILTER (WHERE ${newestDiagnosticPredicate}) AS BIGINT) AS newestDiagnosticRequestProtectedRows,
      0::BIGINT AS dependentPartialBlockedRows,
      CAST(COUNT(*) FILTER (
        WHERE ${terminalCandidatePredicate}
          AND NOT (${activeSnapshotPredicate})
          AND NOT (${activePinPredicate})
          AND NOT (${protectedRequestPredicate})
          AND NOT (${newestDiagnosticPredicate})
      ) AS BIGINT) AS eligibleRows
    FROM ${table} candidate
    LEFT JOIN app.review_rebuild_request request
      ON request.request_id = candidate.request_id
      AND request.project_id = candidate.project_id
    WHERE ${projectPredicate}
  `
}

const getNumberOrNull = (value: number | string | null | undefined) => {
  return value === null || value === undefined ? null : Number(value)
}

const getRetentionCleanupEligibilityTable = async (
  runtime: QueryRuntime,
  table: (typeof retentionCleanupEligibilityTables)[number],
  projectId: string,
): Promise<RetentionCleanupEligibilityTable> => {
  try {
    const rows = await runReadonlyQuery<RetentionCleanupEligibilityAggregateRow>(
      runtime,
      getRetentionCleanupEligibilitySql(table, projectId),
    )
    const blockerRows = await runReadonlyQuery<{category: string; rowCount: number | string}>(
      runtime,
      getRetentionCleanupBlockerCategorySql(table, projectId),
    )
    const row = rows[0]

    return {
      activeOrLastKnownGoodSnapshotProtectedRows: getNumberOrNull(row?.activeOrLastKnownGoodSnapshotProtectedRows),
      blockerCounts: blockerRows.map((blocker) => {
        return {category: blocker.category, rowCount: Number(blocker.rowCount)}
      }),
      completedRequestAndSummaryChunkCandidateRows: getNumberOrNull(row?.completedRequestAndSummaryChunkCandidateRows),
      dependentPartialBlockedRows: getNumberOrNull(row?.dependentPartialBlockedRows),
      eligibleRows: getNumberOrNull(row?.eligibleRows),
      error: null,
      newestDiagnosticRequestProtectedRows: getNumberOrNull(row?.newestDiagnosticRequestProtectedRows),
      pinnedSnapshotProtectedRows: getNumberOrNull(row?.pinnedSnapshotProtectedRows),
      protectedRebuildRequestRows: getNumberOrNull(row?.protectedRebuildRequestRows),
      table,
      totalScopedRows: getNumberOrNull(row?.totalScopedRows),
    }
  } catch (error) {
    return {
      activeOrLastKnownGoodSnapshotProtectedRows: null,
      blockerCounts: [],
      completedRequestAndSummaryChunkCandidateRows: null,
      dependentPartialBlockedRows: null,
      eligibleRows: null,
      error: error instanceof Error ? error.message : String(error),
      newestDiagnosticRequestProtectedRows: null,
      pinnedSnapshotProtectedRows: null,
      protectedRebuildRequestRows: null,
      table,
      totalScopedRows: null,
    }
  }
}

const getRetentionCleanupEligibilityReport = async (
  runtime: QueryRuntime,
  projectId: string,
): Promise<RetentionCleanupEligibilityReport> => {
  const tables: RetentionCleanupEligibilityTable[] = []

  for (const table of retentionCleanupEligibilityTables) {
    tables.push(await getRetentionCleanupEligibilityTable(runtime, table, projectId))
  }

  return {
    note: 'Read-only aggregate eligibility evidence for the first storage-slimming cleanup slice. Counts and first-blocker rows are project-wide diagnostic aggregates, while runtime cleanup still runs through per-project/per-config retention targets and guardrails; first-blocker rows classify each scoped row by the first matching diagnostic predicate and do not authorize deletion or predicate broadening.',
    projectId,
    tables,
  }
}

const getRequiredColumnStatus = async (runtime: QueryRuntime, table: string, requiredColumns: readonly string[]) => {
  if (!(await getTableExists(runtime, table))) {
    return {missingColumns: [], tableExists: false}
  }

  const presentColumns = new Set(
    (await getTableColumns(runtime, table)).map((column) => {
      return column.column_name
    }),
  )
  const missingColumns = requiredColumns.filter((column) => {
    return !presentColumns.has(column)
  })

  return {missingColumns, tableExists: true}
}

const getDirtyWorkAckCoveragePredicate = (dirtyWorkSql: string) => {
  const projectionComponentSql = `json_extract_string(${dirtyWorkSql}.projection_key, '$.projectionComponent')`
  const projectionIdentitySql = `json_extract_string(${dirtyWorkSql}.projection_key, '$.projectionIdentity')`

  return `EXISTS (
            SELECT 1
            FROM app.review_serving_dirty_work_ack ack
            WHERE ack.projection_component = ${projectionComponentSql}
              AND ack.projection_identity = ${projectionIdentitySql}
              AND ack.source_partition = ${dirtyWorkSql}.source_partition
              AND ack.status = 'completed'
              AND ack.completed_source_high_water_mark >= ${dirtyWorkSql}.latest_source_high_water_mark
              AND (
                ack.dirty_work_id = ${dirtyWorkSql}.dirty_work_id
                OR (
                  ack.dirty_work_id IS NULL
                  AND (
                    (ack.dirty_range_start IS NULL AND ack.dirty_range_end IS NULL)
                    OR (
                      ${dirtyWorkSql}.dirty_range_start IS NOT NULL
                      AND ${dirtyWorkSql}.dirty_range_end IS NOT NULL
                      AND ack.dirty_range_start <= ${dirtyWorkSql}.dirty_range_start
                      AND ack.dirty_range_end >= ${dirtyWorkSql}.dirty_range_end
                    )
                  )
                )
              )
          )`
}

const getDirtyWorkProjectWatermarkCoveragePredicate = () => {
  return `dirty_work.project_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM app.review_serving_project_dirty_source_watermark watermark
            WHERE watermark.project_id = dirty_work.project_id
              AND watermark.source_partition = dirty_work.source_partition
              AND watermark.source_high_water_mark >= dirty_work.latest_source_high_water_mark
          )`
}

const getDirtyWorkBlockerCategorySql = (projectId: string) => {
  const projectPredicate = `dirty_work.project_id = ${getSqlLiteral(projectId)}`
  const ackCoveragePredicate = getDirtyWorkAckCoveragePredicate('dirty_work')
  const watermarkCoveragePredicate = getDirtyWorkProjectWatermarkCoveragePredicate()

  return `
    WITH classified AS (
      SELECT
        CASE
          WHEN dirty_work.status IS DISTINCT FROM 'completed' THEN 'non_completed_status'
          WHEN dirty_work.project_id IS NULL THEN 'missing_project_dirty_source_watermark'
          WHEN NOT (${watermarkCoveragePredicate}) THEN 'missing_or_stale_project_dirty_source_watermark'
          WHEN dirty_work.projection_key IS NULL THEN 'missing_projection_key'
          WHEN NOT (${ackCoveragePredicate}) THEN 'missing_completed_ack_or_high_water_coverage'
          ELSE 'eligible_completed_ack_and_project_watermark_covered'
        END AS category
      FROM app.review_serving_dirty_work dirty_work
      WHERE ${projectPredicate}
    )
    SELECT category, CAST(COUNT(*) AS BIGINT) AS rows
    FROM classified
    GROUP BY category
    ORDER BY rows DESC, category
  `
}

const getDirtyWorkRetentionEvidenceReport = async (
  runtime: QueryRuntime,
  projectId: string,
  limit: number,
): Promise<DirtyWorkRetentionEvidenceReport> => {
  const dirtyWorkTable = 'app.review_serving_dirty_work' as const
  const ackTable = 'app.review_serving_dirty_work_ack' as const
  const watermarkTable = 'app.review_serving_project_dirty_source_watermark' as const
  const projectPredicate = `project_id = ${getSqlLiteral(projectId)}`

  try {
    const requiredTables = [
      {
        columns: [
          'dirty_work_id',
          'project_id',
          'projection_key',
          'dirty_kind',
          'source_partition',
          'latest_source_high_water_mark',
          'dirty_range_start',
          'dirty_range_end',
          'status',
        ],
        table: dirtyWorkTable,
      },
      {
        columns: [
          'dirty_ack_id',
          'dirty_work_id',
          'projection_component',
          'projection_identity',
          'source_partition',
          'completed_source_high_water_mark',
          'dirty_range_start',
          'dirty_range_end',
          'status',
        ],
        table: ackTable,
      },
      {columns: ['project_id', 'source_partition', 'source_high_water_mark'], table: watermarkTable},
    ] as const
    const tableProblems: string[] = []

    for (const requiredTable of requiredTables) {
      const status = await getRequiredColumnStatus(runtime, requiredTable.table, requiredTable.columns)

      if (!status.tableExists) {
        tableProblems.push(`missing table ${requiredTable.table}`)
      } else if (status.missingColumns.length > 0) {
        tableProblems.push(`missing columns on ${requiredTable.table}: ${status.missingColumns.join(', ')}`)
      }
    }

    if (tableProblems.length > 0) {
      throw new Error(tableProblems.join('; '))
    }

    const ackCoveragePredicate = getDirtyWorkAckCoveragePredicate('dirty_work')
    const watermarkCoveragePredicate = getDirtyWorkProjectWatermarkCoveragePredicate()
    const lifecycleRows = await runReadonlyQuery<{
      completed: number | string
      failed: number | string
      pending: number | string
      protectedNonCompletedRows: number | string
      running: number | string
      total: number | string
      completedRowsCoveredByAckAndProjectWatermark: number | string
    }>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) AS BIGINT) AS total,
          CAST(COUNT(*) FILTER (WHERE status = 'pending') AS BIGINT) AS pending,
          CAST(COUNT(*) FILTER (WHERE status = 'running') AS BIGINT) AS running,
          CAST(COUNT(*) FILTER (WHERE status = 'failed') AS BIGINT) AS failed,
          CAST(COUNT(*) FILTER (WHERE status = 'completed') AS BIGINT) AS completed,
          CAST(COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'completed') AS BIGINT) AS protectedNonCompletedRows,
          CAST(COUNT(*) FILTER (
            WHERE status = 'completed'
              AND (${ackCoveragePredicate})
              AND (${watermarkCoveragePredicate})
          ) AS BIGINT) AS completedRowsCoveredByAckAndProjectWatermark
        FROM ${dirtyWorkTable} dirty_work
        WHERE dirty_work.${projectPredicate}
      `,
    )
    const ackCounts = await runReadonlyQuery<{ackKind: 'point' | 'synthetic_high_water'; rows: number | string}>(
      runtime,
      `
        WITH project_lanes AS (
          SELECT DISTINCT
            projection_component,
            projection_identity,
            source_partition
          FROM ${dirtyWorkTable}
          WHERE ${projectPredicate}
            AND projection_component IS NOT NULL
            AND projection_identity IS NOT NULL
        )
        SELECT
          CASE WHEN ack.dirty_work_id IS NULL THEN 'synthetic_high_water' ELSE 'point' END AS ackKind,
          CAST(COUNT(*) AS BIGINT) AS rows
        FROM ${ackTable} ack
        WHERE ack.status = 'completed'
          AND EXISTS (
            SELECT 1
            FROM project_lanes lane
            WHERE lane.projection_component = ack.projection_component
              AND lane.projection_identity = ack.projection_identity
              AND lane.source_partition = ack.source_partition
          )
        GROUP BY ackKind
        ORDER BY ackKind
      `,
    )
    const laneCounts = await runReadonlyQuery<{
      dirtyKind: string | null
      projectId: string | null
      projectionComponent: string | null
      projectionIdentity: string | null
      rows: number | string
      sourcePartition: string | null
      status: string | null
    }>(
      runtime,
      `
        SELECT
          COALESCE(project_id, 'NULL') AS projectId,
          COALESCE(projection_component, 'NULL') AS projectionComponent,
          COALESCE(projection_identity, 'NULL') AS projectionIdentity,
          COALESCE(dirty_kind, 'unknown') AS dirtyKind,
          COALESCE(source_partition, 'unknown') AS sourcePartition,
          COALESCE(status, 'unknown') AS status,
          CAST(COUNT(*) AS BIGINT) AS rows
        FROM ${dirtyWorkTable}
        WHERE ${projectPredicate}
        GROUP BY project_id, projectionComponent, projectionIdentity, dirty_kind, source_partition, status
        ORDER BY rows DESC, projectId, projectionComponent, projectionIdentity, dirtyKind, sourcePartition, status
        LIMIT ${Math.max(1, limit)}
      `,
    )
    const blockerCounts = await runReadonlyQuery<{category: string; rows: number | string}>(
      runtime,
      getDirtyWorkBlockerCategorySql(projectId),
    )
    const row = lifecycleRows[0]

    return {
      ackCounts: ackCounts.map((ack) => {
        return {ackKind: ack.ackKind, rows: Number(ack.rows ?? 0)}
      }),
      ackTable,
      blockerCounts: blockerCounts.map((blocker) => {
        return {category: blocker.category, rows: Number(blocker.rows ?? 0)}
      }),
      completedRowsCoveredByAckAndProjectWatermark: getNumberOrNull(row?.completedRowsCoveredByAckAndProjectWatermark),
      dirtyWorkTable,
      error: null,
      laneCounts: laneCounts.map((lane) => {
        return {
          dirtyKind: lane.dirtyKind ?? 'unknown',
          projectId: lane.projectId ?? 'NULL',
          projectionComponent: lane.projectionComponent ?? 'NULL',
          projectionIdentity: lane.projectionIdentity ?? 'NULL',
          rows: Number(lane.rows ?? 0),
          sourcePartition: lane.sourcePartition ?? 'unknown',
          status: lane.status ?? 'unknown',
        }
      }),
      lifecycleCounts: {
        completed: getNumberOrNull(row?.completed),
        failed: getNumberOrNull(row?.failed),
        pending: getNumberOrNull(row?.pending),
        running: getNumberOrNull(row?.running),
        total: getNumberOrNull(row?.total),
      },
      note: 'Read-only dirty-work retention evidence. Completed dirty-work rows are counted as retention candidates only when covered by a completed point ACK or synthetic high-water ACK and by the project/source dirty watermark; non-completed rows are protected diagnostic/work rows. This section does not perform cleanup or authorize runtime deletion.',
      projectId,
      protectedNonCompletedRows: getNumberOrNull(row?.protectedNonCompletedRows),
      verdict: 'not-authorized',
      watermarkTable,
    }
  } catch (error) {
    return {
      ackCounts: [],
      ackTable,
      blockerCounts: [],
      completedRowsCoveredByAckAndProjectWatermark: null,
      dirtyWorkTable,
      error: error instanceof Error ? error.message : String(error),
      laneCounts: [],
      lifecycleCounts: {completed: null, failed: null, pending: null, running: null, total: null},
      note: 'Dirty-work retention evidence collection failed or the required physical schema is absent. Failed evidence collection is not retention cleanup authorization.',
      projectId,
      protectedNonCompletedRows: null,
      verdict: 'blocked',
      watermarkTable,
    }
  }
}

const getRebuildRequestDispositionCaseSql = (requestAlias: string) => {
  return `CASE
            WHEN ${requestAlias}.request_id IS NULL THEN 'missing-rebuild-request'
            WHEN ${requestAlias}.status IN ('pending_admission', 'admitted', 'running')
              AND ${requestAlias}.admission_state = 'admitted' THEN 'admitted-with-chunks'
            WHEN ${requestAlias}.status IN ('pending_admission', 'admitted', 'running')
              THEN 'nonterminal-not-admitted'
            WHEN ${requestAlias}.status = 'failed'
              AND ${requestAlias}.admission_state = 'admitted'
              AND (
                ${requestAlias}.retry_after IS NULL
                OR ${requestAlias}.retry_after <= current_timestamp
              )
              AND EXISTS (
                SELECT 1
                FROM app.review_rebuild_chunk_manifest retryable_chunk
                WHERE retryable_chunk.request_id = ${requestAlias}.request_id
                  AND retryable_chunk.project_id = ${requestAlias}.project_id
                  AND (
                    retryable_chunk.status IN ('pending', 'running')
                    OR (
                      retryable_chunk.status = 'failed'
                      AND COALESCE(retryable_chunk.retry_count, 0) < COALESCE(
                        GREATEST(
                          1,
                          TRY_CAST(json_extract_string(${requestAlias}.retry_policy_json, '$.maxAttempts') AS INTEGER)
                        ),
                        3
                      )
                    )
                  )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM app.review_rebuild_chunk_manifest terminal_blocker_chunk
                WHERE terminal_blocker_chunk.request_id = ${requestAlias}.request_id
                  AND terminal_blocker_chunk.project_id = ${requestAlias}.project_id
                  AND terminal_blocker_chunk.status IN ('blocked_over_budget', 'quarantined')
              ) THEN 'failed-retryable'
            WHEN ${requestAlias}.status = 'failed'
              AND EXISTS (
                SELECT 1
                FROM app.review_rebuild_chunk_manifest terminal_failed_chunk
                WHERE terminal_failed_chunk.request_id = ${requestAlias}.request_id
                  AND terminal_failed_chunk.project_id = ${requestAlias}.project_id
                  AND terminal_failed_chunk.status IN ('blocked_over_budget', 'quarantined')
              ) THEN 'failed-blocked-terminal'
            WHEN ${requestAlias}.status = 'failed'
              AND lower(COALESCE(${requestAlias}.last_error, '')) LIKE '%superseded%' THEN 'failed-superseded-derived'
            WHEN ${requestAlias}.status = 'failed' THEN 'failed-terminal-unclassified'
            WHEN ${requestAlias}.status = 'completed'
              AND ${requestAlias}.admission_state = 'admitted' THEN 'completed-terminal'
            WHEN ${requestAlias}.status IN ('blocked_over_budget', 'quarantined')
              OR ${requestAlias}.admission_state = 'blocked_over_budget' THEN 'blocked-terminal'
            ELSE CONCAT('other:', COALESCE(${requestAlias}.status, 'NULL'), '/', COALESCE(${requestAlias}.admission_state, 'NULL'))
          END`
}

const getRebuildArtifactDispositionEvidenceReport = async (
  runtime: QueryRuntime,
  projectId: string,
  limit: number,
): Promise<RebuildArtifactDispositionEvidenceReport> => {
  const table = 'app.review_rebuild_chunk_manifest' as const
  const projectPredicate = `project_id = ${getSqlLiteral(projectId)}`
  const requestDispositionSql = getRebuildRequestDispositionCaseSql('request')

  try {
    const totals = await runReadonlyQuery<{
      currentProjectChunkRows: number | string
      requestlessChunkRows: number | string
    }>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) AS BIGINT) AS currentProjectChunkRows,
          CAST(COUNT(*) FILTER (WHERE request_id IS NULL) AS BIGINT) AS requestlessChunkRows
        FROM ${table}
        WHERE ${projectPredicate}
      `,
    )
    const requestlessRowsByAdoptionHint = await runReadonlyQuery<{
      adoptionHint: string
      distinctChunks: number | string
      partialDependencyRows: number | string
      rows: number | string
      summaryRows: number | string
    }>(
      runtime,
      `
        WITH requestless_chunk AS (
          SELECT
            chunk.*,
            CASE
              WHEN chunk.projection_component IS DISTINCT FROM 'summary' THEN 'requestless-non-summary'
              WHEN EXISTS (
                SELECT 1
                FROM app.review_rebuild_request request
                WHERE request.project_id = chunk.project_id
                  AND request.request_id LIKE 'requestless-%'
                  AND request.status IN ('admitted', 'running')
                  AND request.admission_state = 'admitted'
                  AND json_extract_string(request.identity_json, '$.snapshotId') IS NOT DISTINCT FROM chunk.snapshot_id
                  AND TRY_CAST(json_extract_string(request.identity_json, '$.outputBaseGeneration') AS BIGINT)
                    IS NOT DISTINCT FROM chunk.output_base_generation
                  AND json_extract_string(request.identity_json, '$.inputDigest') IS NOT DISTINCT FROM chunk.input_digest
              ) THEN 'requestless-adoptable-active-request'
              ELSE 'requestless-unadopted'
            END AS adoption_hint
          FROM ${table} chunk
          WHERE chunk.project_id = ${getSqlLiteral(projectId)}
            AND chunk.request_id IS NULL
        ),
        classified AS (
          SELECT
            requestless_chunk.adoption_hint,
            requestless_chunk.chunk_id,
            requestless_chunk.projection_component,
            0::BIGINT AS partial_dependency_rows
          FROM requestless_chunk
        )
        SELECT
          adoption_hint AS adoptionHint,
          CAST(COUNT(*) AS BIGINT) AS rows,
          CAST(COUNT(DISTINCT chunk_id) AS BIGINT) AS distinctChunks,
          CAST(COUNT(*) FILTER (WHERE projection_component = 'summary') AS BIGINT) AS summaryRows,
          CAST(SUM(partial_dependency_rows) AS BIGINT) AS partialDependencyRows
        FROM classified
        GROUP BY adoption_hint
        ORDER BY rows DESC, adoption_hint
        LIMIT ${Math.max(1, limit)}
      `,
    )
    const artifactRowsByRequestDisposition = await runReadonlyQuery<{
      artifactTable: string
      distinctChunks: number | string
      distinctRequests: number | string
      requestDisposition: string
      rows: number | string
    }>(
      runtime,
      `
        WITH artifact AS (
          SELECT
            'app.review_rebuild_chunk_manifest' AS artifact_table,
            project_id,
            request_id,
            chunk_id
          FROM ${table}
          WHERE project_id = ${getSqlLiteral(projectId)}
          UNION ALL
          SELECT
            'mart.review_article_summary_rebuild_accumulator_v4' AS artifact_table,
            project_id,
            request_id,
            NULL::VARCHAR AS chunk_id
          FROM mart.review_article_summary_rebuild_accumulator_v4
          WHERE project_id = ${getSqlLiteral(projectId)}
        ),
        classified AS (
          SELECT
            artifact.artifact_table,
            artifact.request_id,
            artifact.chunk_id,
            CASE
              WHEN artifact.request_id IS NULL THEN 'requestless-unadopted'
              ELSE ${requestDispositionSql}
            END AS request_disposition
          FROM artifact
          LEFT JOIN app.review_rebuild_request request
            ON request.project_id = artifact.project_id
            AND request.request_id = artifact.request_id
        )
        SELECT
          artifact_table AS artifactTable,
          request_disposition AS requestDisposition,
          CAST(COUNT(*) AS BIGINT) AS rows,
          CAST(COUNT(DISTINCT request_id) AS BIGINT) AS distinctRequests,
          CAST(COUNT(DISTINCT chunk_id) AS BIGINT) AS distinctChunks
        FROM classified
        GROUP BY artifact_table, request_disposition
        ORDER BY artifact_table, rows DESC, request_disposition
        LIMIT ${Math.max(1, limit * 3)}
      `,
    )
    const requestRowsByDisposition = await runReadonlyQuery<{
      chunkRows: number | string
      requestDisposition: string
      requests: number | string
      sampleRequestIds: string | null
    }>(
      runtime,
      `
        WITH request_scope AS (
          SELECT
            request.request_id,
            CASE
              WHEN COUNT(chunk.chunk_id) = 0
                AND request.status IN ('pending_admission', 'admitted', 'running')
                AND request.admission_state = 'admitted' THEN 'admitted-no-chunks'
              ELSE ${requestDispositionSql}
            END AS request_disposition,
            CAST(COUNT(chunk.chunk_id) AS BIGINT) AS chunk_rows
          FROM app.review_rebuild_request request
          LEFT JOIN ${table} chunk
            ON chunk.project_id = request.project_id
            AND chunk.request_id = request.request_id
          WHERE request.project_id = ${getSqlLiteral(projectId)}
          GROUP BY
            request.request_id,
            request.project_id,
            request.status,
            request.admission_state,
            request.retry_after,
            request.retry_policy_json,
            request.last_error
        )
        SELECT
          request_disposition AS requestDisposition,
          CAST(COUNT(*) AS BIGINT) AS requests,
          CAST(SUM(chunk_rows) AS BIGINT) AS chunkRows,
          string_agg(request_id, ', ' ORDER BY request_id) AS sampleRequestIds
        FROM request_scope
        GROUP BY request_disposition
        ORDER BY requests DESC, request_disposition
        LIMIT ${Math.max(1, limit)}
      `,
    )
    const row = totals[0]

    return {
      artifactRowsByRequestDisposition: artifactRowsByRequestDisposition.map((artifactRow) => {
        return {
          artifactTable: artifactRow.artifactTable,
          distinctChunks: Number(artifactRow.distinctChunks ?? 0),
          distinctRequests: Number(artifactRow.distinctRequests ?? 0),
          requestDisposition: artifactRow.requestDisposition,
          rows: Number(artifactRow.rows ?? 0),
        }
      }),
      currentProjectChunkRows: getNumberOrNull(row?.currentProjectChunkRows),
      error: null,
      note: 'Proof-only, read-only current-project disposition evidence for terminal rebuild artifact blockers. Requestless adoption and superseded labels are derived from observable request/chunk state and error text; they explain blocker shape only and do not authorize retention predicate broadening.',
      projectId,
      requestRowsByDisposition: requestRowsByDisposition.map((requestRow) => {
        return {
          chunkRows: Number(requestRow.chunkRows ?? 0),
          requestDisposition: requestRow.requestDisposition,
          requests: Number(requestRow.requests ?? 0),
          sampleRequestIds: (requestRow.sampleRequestIds ?? '').split(', ').filter(Boolean),
        }
      }),
      requestlessChunkRows: getNumberOrNull(row?.requestlessChunkRows),
      requestlessRowsByAdoptionHint: requestlessRowsByAdoptionHint.map((requestlessRow) => {
        return {
          adoptionHint: requestlessRow.adoptionHint,
          distinctChunks: Number(requestlessRow.distinctChunks ?? 0),
          partialDependencyRows: Number(requestlessRow.partialDependencyRows ?? 0),
          rows: Number(requestlessRow.rows ?? 0),
          summaryRows: Number(requestlessRow.summaryRows ?? 0),
        }
      }),
      table,
      verdict: 'not-authorized',
    }
  } catch (error) {
    return {
      artifactRowsByRequestDisposition: [],
      currentProjectChunkRows: null,
      error: error instanceof Error ? error.message : String(error),
      note: 'Read-only rebuild artifact disposition evidence collection failed. Failed evidence collection is not retention cleanup authorization.',
      projectId,
      requestRowsByDisposition: [],
      requestlessChunkRows: null,
      requestlessRowsByAdoptionHint: [],
      table,
      verdict: 'blocked',
    }
  }
}

const getSummaryRebuildAccumulatorLifecycleEvidenceReport = async (
  runtime: QueryRuntime,
  projectId: string,
  limit: number,
): Promise<SummaryRebuildAccumulatorLifecycleEvidenceReport> => {
  const table = 'mart.review_article_summary_rebuild_accumulator_v4' as const
  const requiredColumns = [
    'request_id',
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'source_chunk_ids_key',
  ] as const
  const emptyReport = (
    error: string | null,
    note: string,
    verdict: SummaryRebuildAccumulatorLifecycleEvidenceReport['verdict'],
  ): SummaryRebuildAccumulatorLifecycleEvidenceReport => {
    return {
      activeRequestRows: null,
      admittedRequestRows: null,
      blockerCounts: [],
      completedRequestCandidateRows: null,
      currentProjectRows: null,
      error,
      failedRequestCandidateRows: null,
      globalRows: null,
      newestDiagnosticRequestProtectedRows: null,
      note,
      projectId,
      protectedRequestRows: null,
      rowsByRequestLifecycle: [],
      rowsJoinedToCompletedSummaryChunks: null,
      table,
      terminalRequestCandidateRows: null,
      verdict,
    }
  }

  try {
    if (!(await getTableExists(runtime, table))) {
      return emptyReport(
        null,
        'Read-only proof-only accumulator lifecycle evidence was not collected because mart.review_article_summary_rebuild_accumulator_v4 is absent in this snapshot. Absence is not cleanup authorization.',
        'blocked',
      )
    }

    const accumulatorColumns = await getTableColumns(runtime, table)
    const missingColumns = requiredColumns.filter((column) => {
      return !hasColumn(accumulatorColumns, column)
    })

    if (missingColumns.length > 0) {
      return emptyReport(
        `Missing required evidence columns: ${missingColumns.join(', ')}`,
        'Read-only accumulator lifecycle evidence collection was blocked by table-shape drift. Failed evidence collection is not retention cleanup authorization.',
        'blocked',
      )
    }

    const requestStatus = await getRequiredColumnStatus(runtime, 'app.review_rebuild_request', [
      'request_id',
      'project_id',
      'status',
      'admission_state',
      'retry_after',
      'retry_policy_json',
      'last_error',
      'updated_at',
    ])
    const chunkStatus = await getRequiredColumnStatus(runtime, 'app.review_rebuild_chunk_manifest', [
      'request_id',
      'project_id',
      'chunk_id',
      'projection_component',
      'status',
      'admission_state',
      'retry_count',
    ])
    const manifestStatus = await getRequiredColumnStatus(runtime, 'app.review_serving_snapshot_manifest', [
      'project_id',
      'snapshot_id',
      'snapshot_status',
      'last_known_good_snapshot_id',
      'selected_import_snapshot_id',
    ])
    const pinStatus = await getRequiredColumnStatus(runtime, 'app.review_serving_snapshot_pin', [
      'project_id',
      'snapshot_id',
      'released_at',
      'ref_count',
      'expires_at',
    ])
    const missingJoinShapes = [
      requestStatus.tableExists && requestStatus.missingColumns.length === 0
        ? null
        : `app.review_rebuild_request${
            requestStatus.tableExists ? ` missing ${requestStatus.missingColumns.join(', ')}` : ' absent'
          }`,
      chunkStatus.tableExists && chunkStatus.missingColumns.length === 0
        ? null
        : `app.review_rebuild_chunk_manifest${
            chunkStatus.tableExists ? ` missing ${chunkStatus.missingColumns.join(', ')}` : ' absent'
          }`,
      manifestStatus.tableExists && manifestStatus.missingColumns.length === 0
        ? null
        : `app.review_serving_snapshot_manifest${
            manifestStatus.tableExists ? ` missing ${manifestStatus.missingColumns.join(', ')}` : ' absent'
          }`,
      pinStatus.tableExists && pinStatus.missingColumns.length === 0
        ? null
        : `app.review_serving_snapshot_pin${pinStatus.tableExists ? ` missing ${pinStatus.missingColumns.join(', ')}` : ' absent'}`,
    ].filter((entry): entry is string => {
      return entry !== null
    })

    if (missingJoinShapes.length > 0) {
      return emptyReport(
        `Missing required evidence join shape: ${missingJoinShapes.join('; ')}`,
        'Read-only accumulator lifecycle evidence collection was blocked by missing related-table shape. Failed evidence collection is not retention cleanup authorization.',
        'blocked',
      )
    }

    const requestDispositionSql = getRebuildRequestDispositionCaseSql('request')
    const activeSnapshotPredicate = getActiveSnapshotManifestGuardPredicate('snapshot_id')
    const activePinPredicate = getActiveSnapshotPinGuardPredicate('snapshot_id')
    const protectedRequestPredicate = getProtectedRebuildRequestPredicate('request')
    const newestDiagnosticPredicate = getNewestDiagnosticRebuildRequestPredicate('request')
    const completedSummaryChunkJoinPredicate = `EXISTS (
            SELECT 1
            FROM app.review_rebuild_chunk_manifest chunk
            WHERE chunk.project_id = candidate.project_id
              AND chunk.request_id = candidate.request_id
              AND chunk.projection_component = 'summary'
              AND chunk.status = 'completed'
              AND chunk.admission_state = 'admitted'
              AND contains(candidate.source_chunk_ids_key, CONCAT('\n', chunk.chunk_id, '\n'))
          )`

    const totals = await runReadonlyQuery<{
      activeRequestRows: number | string
      admittedRequestRows: number | string
      completedRequestCandidateRows: number | string
      currentProjectRows: number | string
      failedRequestCandidateRows: number | string
      globalRows: number | string
      newestDiagnosticRequestProtectedRows: number | string
      protectedRequestRows: number | string
      rowsJoinedToCompletedSummaryChunks: number | string
      terminalRequestCandidateRows: number | string
    }>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) AS BIGINT) AS globalRows,
          CAST(COUNT(*) FILTER (WHERE candidate.project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows,
          CAST(COUNT(*) FILTER (WHERE request.status IN ('pending_admission', 'admitted', 'running')) AS BIGINT) AS activeRequestRows,
          CAST(COUNT(*) FILTER (WHERE request.admission_state = 'admitted') AS BIGINT) AS admittedRequestRows,
          CAST(COUNT(*) FILTER (WHERE ${protectedRequestPredicate}) AS BIGINT) AS protectedRequestRows,
          CAST(COUNT(*) FILTER (WHERE ${newestDiagnosticPredicate}) AS BIGINT) AS newestDiagnosticRequestProtectedRows,
          CAST(COUNT(*) FILTER (
            WHERE request.status IN ('completed', 'failed', 'blocked_over_budget', 'quarantined')
          ) AS BIGINT) AS terminalRequestCandidateRows,
          CAST(COUNT(*) FILTER (
            WHERE request.status = 'completed'
              AND request.admission_state = 'admitted'
          ) AS BIGINT) AS completedRequestCandidateRows,
          CAST(COUNT(*) FILTER (WHERE request.status = 'failed') AS BIGINT) AS failedRequestCandidateRows,
          CAST(COUNT(*) FILTER (WHERE ${completedSummaryChunkJoinPredicate}) AS BIGINT) AS rowsJoinedToCompletedSummaryChunks
        FROM ${table} candidate
        LEFT JOIN app.review_rebuild_request request
          ON request.project_id = candidate.project_id
          AND request.request_id = candidate.request_id
      `,
    )
    const rowsByRequestLifecycle = await runReadonlyQuery<{
      admissionState: string | null
      distinctRequests: number | string
      requestDisposition: string
      requestStatus: string | null
      rows: number | string
    }>(
      runtime,
      `
        SELECT
          ${requestDispositionSql} AS requestDisposition,
          COALESCE(request.status, 'missing') AS requestStatus,
          COALESCE(request.admission_state, 'missing') AS admissionState,
          CAST(COUNT(*) AS BIGINT) AS rows,
          CAST(COUNT(DISTINCT candidate.request_id) AS BIGINT) AS distinctRequests
        FROM ${table} candidate
        LEFT JOIN app.review_rebuild_request request
          ON request.project_id = candidate.project_id
          AND request.request_id = candidate.request_id
        WHERE candidate.project_id = ${getSqlLiteral(projectId)}
        GROUP BY requestDisposition, request.status, request.admission_state
        ORDER BY rows DESC, requestDisposition, requestStatus, admissionState
        LIMIT ${Math.max(1, limit)}
      `,
    )
    const blockerCounts = await runReadonlyQuery<{category: string; rows: number | string}>(
      runtime,
      `
        WITH classified AS (
          SELECT
            CASE
              WHEN candidate.request_id IS NULL THEN 'missing_request_id'
              WHEN candidate.source_chunk_ids_key IS NULL THEN 'missing_source_chunk_ids_key'
              WHEN request.request_id IS NULL THEN 'missing_rebuild_request'
              WHEN ${protectedRequestPredicate} THEN 'protected_rebuild_request'
              WHEN ${newestDiagnosticPredicate} THEN 'newest_diagnostic_request'
              WHEN ${activeSnapshotPredicate} THEN 'active_or_last_known_good_snapshot_protected'
              WHEN ${activePinPredicate} THEN 'pinned_snapshot_protected'
              WHEN NOT (${getManifestReviewConfigHashPredicate()}) THEN 'missing_snapshot_manifest'
              WHEN request.status IS DISTINCT FROM 'completed'
                OR request.admission_state IS DISTINCT FROM 'admitted' THEN 'request_not_completed_admitted'
              WHEN NOT (${completedSummaryChunkJoinPredicate}) THEN 'no_completed_summary_chunk_join'
              ELSE 'proof_only_completed_accumulator_candidate_not_authorized'
            END AS category
          FROM ${table} candidate
          LEFT JOIN app.review_rebuild_request request
            ON request.project_id = candidate.project_id
            AND request.request_id = candidate.request_id
          WHERE candidate.project_id = ${getSqlLiteral(projectId)}
        )
        SELECT category, CAST(COUNT(*) AS BIGINT) AS rows
        FROM classified
        GROUP BY category
        ORDER BY rows DESC, category
        LIMIT ${Math.max(1, limit)}
      `,
    )
    const row = totals[0]

    return {
      activeRequestRows: getNumberOrNull(row?.activeRequestRows),
      admittedRequestRows: getNumberOrNull(row?.admittedRequestRows),
      blockerCounts: blockerCounts.map((blocker) => {
        return {category: blocker.category, rows: Number(blocker.rows ?? 0)}
      }),
      completedRequestCandidateRows: getNumberOrNull(row?.completedRequestCandidateRows),
      currentProjectRows: getNumberOrNull(row?.currentProjectRows),
      error: null,
      failedRequestCandidateRows: getNumberOrNull(row?.failedRequestCandidateRows),
      globalRows: getNumberOrNull(row?.globalRows),
      newestDiagnosticRequestProtectedRows: getNumberOrNull(row?.newestDiagnosticRequestProtectedRows),
      note: 'Read-only proof-only lifecycle/retention evidence for mart.review_article_summary_rebuild_accumulator_v4. Completed accumulator rows joined to completed summary chunks are candidate evidence only; this section does not authorize runtime retention behavior, deletion, service table specs, or migrations.',
      projectId,
      protectedRequestRows: getNumberOrNull(row?.protectedRequestRows),
      rowsByRequestLifecycle: rowsByRequestLifecycle.map((lifecycleRow) => {
        return {
          admissionState: lifecycleRow.admissionState ?? 'missing',
          distinctRequests: Number(lifecycleRow.distinctRequests ?? 0),
          requestDisposition: lifecycleRow.requestDisposition,
          requestStatus: lifecycleRow.requestStatus ?? 'missing',
          rows: Number(lifecycleRow.rows ?? 0),
        }
      }),
      rowsJoinedToCompletedSummaryChunks: getNumberOrNull(row?.rowsJoinedToCompletedSummaryChunks),
      table,
      terminalRequestCandidateRows: getNumberOrNull(row?.terminalRequestCandidateRows),
      verdict: 'not-authorized',
    }
  } catch (error) {
    return emptyReport(
      error instanceof Error ? error.message : String(error),
      'Read-only accumulator lifecycle evidence collection failed. Failed evidence collection is not retention cleanup authorization.',
      'blocked',
    )
  }
}

const getRebuildRequestLifecycleFieldReport = async (
  runtime: QueryRuntime,
  projectId: string,
  limit: number,
): Promise<RebuildRequestLifecycleFieldReport> => {
  const table = 'app.review_rebuild_request' as const
  const nonNullLifecyclePredicate = rebuildRequestLifecycleNullableColumns
    .map((column) => {
      return `${column} IS NOT NULL`
    })
    .join(' OR ')
  const nullableColumnExpressions = rebuildRequestLifecycleNullableColumns
    .map((column) => {
      return `CAST(COUNT(*) FILTER (WHERE ${column} IS NULL) AS BIGINT) AS global_${column}_nullCount,
        CAST(COUNT(*) FILTER (WHERE ${column} IS NOT NULL) AS BIGINT) AS global_${column}_nonNullCount,
        CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)} AND ${column} IS NULL) AS BIGINT) AS currentProject_${column}_nullCount,
        CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)} AND ${column} IS NOT NULL) AS BIGINT) AS currentProject_${column}_nonNullCount`
    })
    .join(',\n        ')

  try {
    const rows = await runReadonlyQuery<Record<string, number | string | null>>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) AS BIGINT) AS globalRows,
          CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows,
          ${nullableColumnExpressions}
        FROM ${table}
      `,
    )
    const rowsByReasonAndStatus = await runReadonlyQuery<RebuildRequestLifecycleReasonRow>(
      runtime,
      `
        SELECT
          COALESCE(reason, 'unknown') AS reason,
          COALESCE(status, 'unknown') AS status,
          COALESCE(admission_state, 'unknown') AS admissionState,
          CAST(COUNT(*) AS BIGINT) AS rows,
          CAST(COUNT(*) FILTER (WHERE ${nonNullLifecyclePredicate}) AS BIGINT) AS nonNullLifecycleFieldRows
        FROM ${table}
        WHERE project_id = ${getSqlLiteral(projectId)}
        GROUP BY reason, status, admission_state
        ORDER BY rows DESC, reason, status, admission_state
        LIMIT ${Math.max(1, limit)}
      `,
    )
    const row = rows[0] ?? {}

    return {
      columns: rebuildRequestLifecycleNullableColumns.map((column) => {
        return {
          column,
          currentProjectNonNullCount: getNumberOrNull(row[`currentProject_${column}_nonNullCount`]),
          currentProjectNullCount: getNumberOrNull(row[`currentProject_${column}_nullCount`]),
          globalNonNullCount: getNumberOrNull(row[`global_${column}_nonNullCount`]),
          globalNullCount: getNumberOrNull(row[`global_${column}_nullCount`]),
        }
      }),
      currentProjectRows: getNumberOrNull(row.currentProjectRows),
      error: null,
      globalRows: getNumberOrNull(row.globalRows),
      note: 'Read-only nullness and lifecycle-bucket evidence for rebuild request retry/OOM/lease fields. Null evidence is not schema-slimming authorization: these fields are admission, retry, over-budget, owner lease, and operator recovery state until lifecycle tests and live progress proof show otherwise.',
      projectId,
      rowsByReasonAndStatus: rowsByReasonAndStatus.map((reasonRow) => {
        return {
          admissionState: reasonRow.admissionState,
          nonNullLifecycleFieldRows: Number(reasonRow.nonNullLifecycleFieldRows ?? 0),
          reason: reasonRow.reason,
          rows: Number(reasonRow.rows ?? 0),
          status: reasonRow.status,
        }
      }),
      table,
      verdict: 'not-authorized',
    }
  } catch (error) {
    return {
      columns: [],
      currentProjectRows: null,
      error: error instanceof Error ? error.message : String(error),
      globalRows: null,
      note: 'Rebuild request lifecycle field evidence collection failed. Failed evidence collection is not slimming authorization.',
      projectId,
      rowsByReasonAndStatus: [],
      table,
      verdict: 'blocked',
    }
  }
}

const getProjectorWatermarkNullableFieldReport = async (
  runtime: QueryRuntime,
  projectId: string,
  limit: number,
): Promise<ProjectorWatermarkNullableFieldReport> => {
  const table = 'app.review_serving_projector_watermark' as const
  const nullableColumnExpressions = projectorWatermarkNullableColumns
    .map((column) => {
      return `CAST(COUNT(*) FILTER (WHERE ${column} IS NULL) AS BIGINT) AS global_${column}_nullCount,
        CAST(COUNT(*) FILTER (WHERE ${column} IS NOT NULL) AS BIGINT) AS global_${column}_nonNullCount,
        CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)} AND ${column} IS NULL) AS BIGINT) AS currentProject_${column}_nullCount,
        CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)} AND ${column} IS NOT NULL) AS BIGINT) AS currentProject_${column}_nonNullCount`
    })
    .join(',\n        ')

  try {
    const rows = await runReadonlyQuery<Record<string, number | string | null>>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) AS BIGINT) AS globalRows,
          CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows,
          ${nullableColumnExpressions}
        FROM ${table}
      `,
    )
    const projectScopeRows = await getSummaryContributionServingGroupedRows(
      runtime,
      table,
      `CASE
        WHEN project_id IS NULL THEN 'global-null-project'
        WHEN project_id = ${getSqlLiteral(projectId)} THEN 'current-project'
        ELSE 'other-project'
      END`,
      'projectScope',
      null,
    )
    const sourcePartitionRows = await getSummaryContributionServingGroupedRows(
      runtime,
      table,
      'source_partition',
      'sourcePartition',
      limit,
    )
    const row = rows[0] ?? {}

    return {
      columns: projectorWatermarkNullableColumns.map((column) => {
        return {
          column,
          currentProjectNonNullCount: getNumberOrNull(row[`currentProject_${column}_nonNullCount`]),
          currentProjectNullCount: getNumberOrNull(row[`currentProject_${column}_nullCount`]),
          globalNonNullCount: getNumberOrNull(row[`global_${column}_nonNullCount`]),
          globalNullCount: getNumberOrNull(row[`global_${column}_nullCount`]),
        }
      }),
      currentProjectRows: getNumberOrNull(row.currentProjectRows),
      error: null,
      globalRows: getNumberOrNull(row.globalRows),
      note: 'Read-only global/current-project aggregate evidence for nullable projector watermark fields. Null evidence is not schema-slimming authorization: project_id and import_route_id are part of watermark scope/identity for global and import-route scoped watermarks. Retired lease/cursor/error/snapshot placeholders are intentionally not queried.',
      projectId,
      rowsByProjectScope: projectScopeRows,
      rowsBySourcePartition: sourcePartitionRows,
      table,
      verdict: 'not-authorized',
    }
  } catch (error) {
    return {
      columns: [],
      currentProjectRows: null,
      error: error instanceof Error ? error.message : String(error),
      globalRows: null,
      note: 'Projector watermark nullable field evidence collection failed. Failed evidence collection is not slimming authorization.',
      projectId,
      rowsByProjectScope: [],
      rowsBySourcePartition: [],
      table,
      verdict: 'blocked',
    }
  }
}

const getFilteredCountServingPhysicalEvidenceReport = async (
  runtime: QueryRuntime,
  projectId: string,
  limit: number,
): Promise<FilteredCountServingPhysicalEvidenceReport> => {
  const table = 'mart.review_filtered_count_serving_v4' as const
  const requiredColumns = ['project_id', 'review_config_hash', 'snapshot_id', 'list_mode_key']

  try {
    if (!(await getTableExists(runtime, table))) {
      return {
        activeOrLastKnownGoodSnapshotProtectedRows: null,
        currentProjectRows: null,
        error: null,
        globalRowCount: null,
        groupStats: {avgRowsPerProjectConfigSnapshotListMode: null, maxRowsPerProjectConfigSnapshotListMode: null},
        missingSnapshotManifestRows: null,
        note: 'Read-only physical evidence only. mart.review_filtered_count_serving_v4 is absent in this snapshot, so no row-retention evidence was collected and this section is not deletion authorization.',
        pinnedSnapshotProtectedRows: null,
        projectId,
        rowsBySnapshotStatusAndListMode: [],
        staleByTtlCandidateCounts: [],
        table,
        totalRowCount: null,
        verdict: 'blocked',
      }
    }

    const columns = await getTableColumns(runtime, table)
    const missingColumns = requiredColumns.filter((column) => {
      return !hasColumn(columns, column)
    })

    if (missingColumns.length > 0) {
      return {
        activeOrLastKnownGoodSnapshotProtectedRows: null,
        currentProjectRows: null,
        error: `Missing required evidence columns: ${missingColumns.join(', ')}`,
        globalRowCount: null,
        groupStats: {avgRowsPerProjectConfigSnapshotListMode: null, maxRowsPerProjectConfigSnapshotListMode: null},
        missingSnapshotManifestRows: null,
        note: 'Read-only physical evidence collection was blocked by table-shape drift. Failed evidence collection is not deletion authorization.',
        pinnedSnapshotProtectedRows: null,
        projectId,
        rowsBySnapshotStatusAndListMode: [],
        staleByTtlCandidateCounts: [],
        table,
        totalRowCount: null,
        verdict: 'blocked',
      }
    }

    const manifestExists = await getTableExists(runtime, 'app.review_serving_snapshot_manifest')
    const manifestColumns = manifestExists ? await getTableColumns(runtime, 'app.review_serving_snapshot_manifest') : []
    const hasManifestJoinShape =
      manifestExists
      && hasColumn(manifestColumns, 'project_id')
      && hasColumn(manifestColumns, 'snapshot_id')
      && hasColumn(manifestColumns, 'snapshot_status')
    const hasManifestGuardShape =
      hasManifestJoinShape
      && hasColumn(manifestColumns, 'last_known_good_snapshot_id')
      && hasColumn(manifestColumns, 'selected_import_snapshot_id')
    const pinExists = await getTableExists(runtime, 'app.review_serving_snapshot_pin')
    const pinColumns = pinExists ? await getTableColumns(runtime, 'app.review_serving_snapshot_pin') : []
    const hasPinGuardShape =
      pinExists
      && hasColumn(pinColumns, 'project_id')
      && hasColumn(pinColumns, 'snapshot_id')
      && hasColumn(pinColumns, 'released_at')
      && hasColumn(pinColumns, 'ref_count')
      && hasColumn(pinColumns, 'expires_at')
    const hasCountUpdatedAt = hasColumn(columns, 'count_updated_at')
    const activeOrLastKnownGoodPredicate = hasManifestGuardShape
      ? getActiveSnapshotManifestGuardPredicate('snapshot_id')
      : 'FALSE'
    const pinnedPredicate = hasPinGuardShape ? getActiveSnapshotPinGuardPredicate('snapshot_id') : 'FALSE'
    const snapshotStatusExpression = hasManifestJoinShape
      ? "COALESCE(manifest.snapshot_status, 'missing-manifest')"
      : "'unknown'"
    const manifestJoinSql = hasManifestJoinShape
      ? `
          LEFT JOIN app.review_serving_snapshot_manifest manifest
            ON manifest.project_id = candidate.project_id
            AND manifest.snapshot_id = candidate.snapshot_id
        `
      : ''
    const staleCandidateFilter = hasCountUpdatedAt
      ? `snapshot_status = 'candidate' AND count_updated_at < current_timestamp - INTERVAL`
      : null

    const countRows = await runReadonlyQuery<{
      activeOrLastKnownGoodSnapshotProtectedRows: number | string
      currentProjectRows: number | string
      globalRowCount: number | string
      missingSnapshotManifestRows: number | string
      pinnedSnapshotProtectedRows: number | string
    }>(
      runtime,
      `
        WITH classified AS (
          SELECT
            candidate.*,
            ${activeOrLastKnownGoodPredicate} AS active_or_last_known_good_protected,
            ${pinnedPredicate} AS pinned_protected,
            ${snapshotStatusExpression} AS snapshot_status
          FROM ${table} candidate
          ${manifestJoinSql}
        )
        SELECT
          CAST(COUNT(*) AS BIGINT) AS globalRowCount,
          CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows,
          CAST(COUNT(*) FILTER (WHERE active_or_last_known_good_protected) AS BIGINT) AS activeOrLastKnownGoodSnapshotProtectedRows,
          CAST(COUNT(*) FILTER (WHERE pinned_protected) AS BIGINT) AS pinnedSnapshotProtectedRows,
          CAST(COUNT(*) FILTER (WHERE snapshot_status = 'missing-manifest') AS BIGINT) AS missingSnapshotManifestRows
        FROM classified
      `,
    )
    const groupStatsRows = await runReadonlyQuery<{
      avgRowsPerProjectConfigSnapshotListMode: number | string | null
      maxRowsPerProjectConfigSnapshotListMode: number | string | null
    }>(
      runtime,
      `
        WITH grouped AS (
          SELECT
            project_id,
            review_config_hash,
            snapshot_id,
            list_mode_key,
            COUNT(*) AS rows_per_group
          FROM ${table}
          GROUP BY project_id, review_config_hash, snapshot_id, list_mode_key
        )
        SELECT
          CAST(MAX(rows_per_group) AS BIGINT) AS maxRowsPerProjectConfigSnapshotListMode,
          AVG(rows_per_group) AS avgRowsPerProjectConfigSnapshotListMode
        FROM grouped
      `,
    )
    const statusRows = await runReadonlyQuery<{
      currentProjectRows: number | string
      listModeKey: string | null
      rowCount: number | string
      snapshotStatus: string | null
    }>(
      runtime,
      `
        WITH classified AS (
          SELECT
            candidate.*,
            ${snapshotStatusExpression} AS snapshot_status
          FROM ${table} candidate
          ${manifestJoinSql}
        )
        SELECT
          snapshot_status AS snapshotStatus,
          list_mode_key AS listModeKey,
          CAST(COUNT(*) AS BIGINT) AS rowCount,
          CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows
        FROM classified
        GROUP BY snapshot_status, list_mode_key
        HAVING COUNT(*) > 0
        ORDER BY COUNT(*) DESC, snapshot_status, list_mode_key
        LIMIT ${Math.max(1, limit)}
      `,
    )
    const staleByTtlCandidateCounts = staleCandidateFilter
      ? await runReadonlyQuery<FilteredCountServingPhysicalEvidenceBucketRow>(
          runtime,
          `
            WITH classified AS (
              SELECT
                candidate.*,
                ${snapshotStatusExpression} AS snapshot_status
              FROM ${table} candidate
              ${manifestJoinSql}
            )
            SELECT
              bucket,
              CAST(candidateRows AS BIGINT) AS candidateRows,
              CAST(currentProjectCandidateRows AS BIGINT) AS currentProjectCandidateRows
            FROM (
              SELECT
                'older-than-7d' AS bucket,
                COUNT(*) FILTER (WHERE ${staleCandidateFilter} 7 DAY) AS candidateRows,
                COUNT(*) FILTER (
                  WHERE project_id = ${getSqlLiteral(projectId)} AND ${staleCandidateFilter} 7 DAY
                ) AS currentProjectCandidateRows
              FROM classified
              UNION ALL
              SELECT
                'older-than-14d' AS bucket,
                COUNT(*) FILTER (WHERE ${staleCandidateFilter} 14 DAY) AS candidateRows,
                COUNT(*) FILTER (
                  WHERE project_id = ${getSqlLiteral(projectId)} AND ${staleCandidateFilter} 14 DAY
                ) AS currentProjectCandidateRows
              FROM classified
              UNION ALL
              SELECT
                'older-than-30d' AS bucket,
                COUNT(*) FILTER (WHERE ${staleCandidateFilter} 30 DAY) AS candidateRows,
                COUNT(*) FILTER (
                  WHERE project_id = ${getSqlLiteral(projectId)} AND ${staleCandidateFilter} 30 DAY
                ) AS currentProjectCandidateRows
              FROM classified
            ) ttl_buckets
          `,
        )
      : []
    const row = countRows[0]
    const groupStatsRow = groupStatsRows[0]

    return {
      activeOrLastKnownGoodSnapshotProtectedRows: getNumberOrNull(row?.activeOrLastKnownGoodSnapshotProtectedRows),
      currentProjectRows: getNumberOrNull(row?.currentProjectRows),
      error: null,
      globalRowCount: getNumberOrNull(row?.globalRowCount),
      groupStats: {
        avgRowsPerProjectConfigSnapshotListMode: getNumberOrNull(
          groupStatsRow?.avgRowsPerProjectConfigSnapshotListMode,
        ),
        maxRowsPerProjectConfigSnapshotListMode: getNumberOrNull(
          groupStatsRow?.maxRowsPerProjectConfigSnapshotListMode,
        ),
      },
      missingSnapshotManifestRows: getNumberOrNull(row?.missingSnapshotManifestRows),
      note: `Read-only proof-only physical evidence for dynamic filtered-count serving rows. Snapshot-protection evidence uses active/LKG${
        hasPinGuardShape ? '/pinned' : ''
      } manifest context available in this snapshot; stale TTL buckets are conservative candidate-row counts and are not retention policy, deletion authorization, or migration authorization.`,
      pinnedSnapshotProtectedRows: getNumberOrNull(row?.pinnedSnapshotProtectedRows),
      projectId,
      rowsBySnapshotStatusAndListMode: statusRows.map((statusRow) => {
        return {
          currentProjectRows: Number(statusRow.currentProjectRows ?? 0),
          listModeKey: String(statusRow.listModeKey ?? 'NULL'),
          rowCount: Number(statusRow.rowCount ?? 0),
          snapshotStatus: String(statusRow.snapshotStatus ?? 'NULL'),
        }
      }),
      staleByTtlCandidateCounts: staleByTtlCandidateCounts.map((bucket) => {
        return {
          bucket: bucket.bucket,
          candidateRows: Number(bucket.candidateRows ?? 0),
          currentProjectCandidateRows: Number(bucket.currentProjectCandidateRows ?? 0),
        }
      }),
      table,
      totalRowCount: getNumberOrNull(row?.globalRowCount),
      verdict: 'not-authorized',
    }
  } catch (error) {
    return {
      activeOrLastKnownGoodSnapshotProtectedRows: null,
      currentProjectRows: null,
      error: error instanceof Error ? error.message : String(error),
      globalRowCount: null,
      groupStats: {avgRowsPerProjectConfigSnapshotListMode: null, maxRowsPerProjectConfigSnapshotListMode: null},
      missingSnapshotManifestRows: null,
      note: 'Read-only filtered-count physical evidence collection failed. Failed evidence collection is not deletion authorization.',
      pinnedSnapshotProtectedRows: null,
      projectId,
      rowsBySnapshotStatusAndListMode: [],
      staleByTtlCandidateCounts: [],
      table,
      totalRowCount: null,
      verdict: 'blocked',
    }
  }
}

const getSelectedImportPayloadSlimmingReadinessReport = async (
  runtime: QueryRuntime,
  projectId: string,
): Promise<SelectedImportPayloadSlimmingReadinessReport> => {
  const hotFieldExpressions = selectedImportPayloadColumns
    .map((column) => {
      return `CAST(COUNT(*) FILTER (WHERE hot_field.${column} IS NULL) AS BIGINT) AS hotField_${column}_nullCount,
        CAST(COUNT(*) FILTER (WHERE hot_field.${column} IS NOT NULL) AS BIGINT) AS hotField_${column}_nonNullCount`
    })
    .join(',\n        ')
  const emptyGlobalDisplayCopyEvidence: SelectedImportDisplayCopyGlobalEvidence = {
    activeOrLastKnownGoodRows: null,
    candidateRows: null,
    columns: [],
    otherRows: null,
    rows: [],
    totalRows: null,
  }
  const emptyDuplicateConflictEvidence: SelectedImportDuplicateConflictGlobalEvidence = {
    activeOrLastKnownGoodRows: null,
    candidateRows: null,
    conflictMismatchRows: null,
    conflictFlagStatus: 'retired/dropped',
    duplicateFlagStatus: 'retired/dropped',
    duplicateMismatchRows: null,
    hotConflictTrueRows: null,
    hotDuplicateTrueRows: null,
    hotResolvedRows: null,
    missingHotRows: null,
    note: 'Duplicate/conflict fallback evidence was not collected.',
    otherRows: null,
    rows: [],
    selectedBaseConflictTrueRows: null,
    selectedBaseDuplicateTrueRows: null,
    selectedBaseFalseOrDefaultConflictRowsWithoutHot: null,
    selectedBaseFalseOrDefaultDuplicateRowsWithoutHot: null,
    selectedBaseTrueConflictRowsWithoutHot: null,
    selectedBaseTrueDuplicateRowsWithoutHot: null,
    totalRows: null,
  }

  try {
    const selectedBaseColumnRows = await runReadonlyQuery<{columnName: string}>(
      runtime,
      `
        SELECT column_name AS "columnName"
        FROM information_schema.columns
        WHERE table_schema = 'app'
          AND table_name = 'review_selected_article_import_v4'
      `,
    )
    const selectedBaseColumnNames = new Set(
      selectedBaseColumnRows.map((row) => {
        return row.columnName
      }),
    )
    const selectedBaseExpressions = selectedImportPayloadColumns
      .map((column) => {
        return getSelectedBaseColumnExpressions(column, selectedBaseColumnNames)
      })
      .join(',\n        ')
    const globalDisplayCopyExpressions = selectedImportDisplayCopyColumns
      .map((column) => {
        return getGlobalDisplayCopyExpressions(column, selectedBaseColumnNames)
      })
      .join(',\n        ')
    const duplicateFlagStatus = selectedBaseColumnNames.has('duplicate_flag') ? 'active' : 'retired/dropped'
    const conflictFlagStatus = selectedBaseColumnNames.has('conflict_flag') ? 'active' : 'retired/dropped'
    const selectedBaseDuplicateFlagSql = duplicateFlagStatus === 'active' ? 'duplicate_flag' : 'FALSE'
    const selectedBaseConflictFlagSql = conflictFlagStatus === 'active' ? 'conflict_flag' : 'FALSE'
    const selectedBaseRows = await runReadonlyQuery<Record<string, number | string | null>>(
      runtime,
      `
        WITH active_manifest AS (
          SELECT
            manifest.project_id,
            manifest.selected_import_snapshot_id,
            manifest.last_known_good_snapshot_id
          FROM app.review_serving_snapshot_manifest manifest
          WHERE manifest.project_id = ${getSqlLiteral(projectId)}
            AND manifest.snapshot_status = 'active'
        ),
        protected_selected_import_snapshot AS (
          SELECT selected_import_snapshot_id
          FROM active_manifest
          WHERE selected_import_snapshot_id IS NOT NULL
          UNION
          SELECT last_known_good_manifest.selected_import_snapshot_id
          FROM active_manifest
          INNER JOIN app.review_serving_snapshot_manifest last_known_good_manifest
            ON last_known_good_manifest.project_id = active_manifest.project_id
            AND last_known_good_manifest.snapshot_id = active_manifest.last_known_good_snapshot_id
          WHERE last_known_good_manifest.selected_import_snapshot_id IS NOT NULL
        ),
        selected_base AS (
          SELECT
            raw_selected_base.*,
            CASE
              WHEN protected_selected_import_snapshot.selected_import_snapshot_id IS NOT NULL
                THEN 'active-or-last-known-good'
              WHEN COALESCE(selected_import_snapshot.status, 'missing-selected-import-snapshot') = 'candidate'
                THEN 'candidate'
              ELSE 'other'
            END AS protection_bucket
          FROM mart.review_selected_article_import_current_v4 raw_selected_base
          LEFT JOIN app.review_selected_import_snapshot selected_import_snapshot
            ON selected_import_snapshot.project_id = raw_selected_base.project_id
            AND selected_import_snapshot.project_scope_identity = raw_selected_base.project_scope_identity
            AND selected_import_snapshot.selected_import_snapshot_id = raw_selected_base.selected_import_snapshot_id
          LEFT JOIN protected_selected_import_snapshot
            ON protected_selected_import_snapshot.selected_import_snapshot_id = raw_selected_base.selected_import_snapshot_id
          WHERE raw_selected_base.project_id = ${getSqlLiteral(projectId)}
        )
        SELECT
          CAST(COUNT(*) AS BIGINT) AS selectedBaseScopedRows,
          CAST(COUNT(*) FILTER (WHERE protection_bucket = 'active-or-last-known-good') AS BIGINT) AS activeOrLastKnownGoodSelectedImportRows,
          CAST(COUNT(*) FILTER (WHERE protection_bucket = 'candidate') AS BIGINT) AS candidateSelectedImportRows,
          CAST(COUNT(*) FILTER (WHERE protection_bucket = 'other') AS BIGINT) AS otherSelectedImportRows,
          ${selectedBaseExpressions}
        FROM selected_base
      `,
    )
    const snapshotStatusRows = await runReadonlyQuery<{rowCount: number | string; snapshotStatus: string | null}>(
      runtime,
      `
        SELECT
          COALESCE(selected_import_snapshot.status, 'missing-selected-import-snapshot') AS snapshotStatus,
          CAST(COUNT(*) AS BIGINT) AS rowCount
        FROM mart.review_selected_article_import_current_v4 selected_base
        LEFT JOIN app.review_selected_import_snapshot selected_import_snapshot
          ON selected_import_snapshot.project_id = selected_base.project_id
          AND selected_import_snapshot.project_scope_identity = selected_base.project_scope_identity
          AND selected_import_snapshot.selected_import_snapshot_id = selected_base.selected_import_snapshot_id
        WHERE selected_base.project_id = ${getSqlLiteral(projectId)}
        GROUP BY 1
        ORDER BY COUNT(*) DESC, snapshotStatus
      `,
    )
    const hotFieldRows = await runReadonlyQuery<Record<string, number | string | null>>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) AS BIGINT) AS hotFieldScopedRows,
          ${hotFieldExpressions}
        FROM app.review_import_article_hot_field hot_field
        INNER JOIN app.project_import_route project_route
          ON project_route.import_route_id = hot_field.import_route_id
          AND project_route.project_id = ${getSqlLiteral(projectId)}
      `,
    )
    const globalDisplayCopyRows = await runReadonlyQuery<Record<string, number | string | boolean | null>>(
      runtime,
      `
        WITH active_manifest AS (
          SELECT
            manifest.project_id,
            manifest.selected_import_snapshot_id,
            manifest.last_known_good_snapshot_id
          FROM app.review_serving_snapshot_manifest manifest
          WHERE manifest.snapshot_status = 'active'
        ),
        protected_selected_import_snapshot AS (
          SELECT
            project_id,
            selected_import_snapshot_id
          FROM active_manifest
          WHERE selected_import_snapshot_id IS NOT NULL
          UNION
          SELECT
            active_manifest.project_id,
            last_known_good_manifest.selected_import_snapshot_id
          FROM active_manifest
          INNER JOIN app.review_serving_snapshot_manifest last_known_good_manifest
            ON last_known_good_manifest.project_id = active_manifest.project_id
            AND last_known_good_manifest.snapshot_id = active_manifest.last_known_good_snapshot_id
          WHERE last_known_good_manifest.selected_import_snapshot_id IS NOT NULL
        ),
        selected_base AS (
          SELECT
            raw_selected_base.*,
            COALESCE(selected_import_snapshot.status, 'missing-selected-import-snapshot') AS snapshot_status,
            protected_selected_import_snapshot.selected_import_snapshot_id IS NOT NULL AS active_or_last_known_good_protected
          FROM mart.review_selected_article_import_current_v4 raw_selected_base
          LEFT JOIN app.review_selected_import_snapshot selected_import_snapshot
            ON selected_import_snapshot.project_id = raw_selected_base.project_id
            AND selected_import_snapshot.project_scope_identity = raw_selected_base.project_scope_identity
            AND selected_import_snapshot.selected_import_snapshot_id = raw_selected_base.selected_import_snapshot_id
          LEFT JOIN protected_selected_import_snapshot
            ON protected_selected_import_snapshot.project_id = raw_selected_base.project_id
            AND protected_selected_import_snapshot.selected_import_snapshot_id = raw_selected_base.selected_import_snapshot_id
        )
        SELECT
          snapshot_status AS snapshotStatus,
          active_or_last_known_good_protected AS activeOrLastKnownGoodProtected,
          CAST(COUNT(*) AS BIGINT) AS rowCount,
          CAST(COUNT(*) FILTER (WHERE active_or_last_known_good_protected) AS BIGINT) AS activeOrLastKnownGoodRows,
          CAST(COUNT(*) FILTER (WHERE snapshot_status = 'candidate') AS BIGINT) AS candidateRows,
          CAST(COUNT(*) FILTER (WHERE NOT active_or_last_known_good_protected AND snapshot_status <> 'candidate') AS BIGINT) AS otherRows,
          ${globalDisplayCopyExpressions}
        FROM selected_base
        GROUP BY 1, 2
        ORDER BY COUNT(*) DESC, snapshot_status, active_or_last_known_good_protected DESC
      `,
    )
    const duplicateConflictRows = await runReadonlyQuery<Record<string, number | string | boolean | null>>(
      runtime,
      `
        WITH active_manifest AS (
          SELECT
            manifest.project_id,
            manifest.selected_import_snapshot_id,
            manifest.last_known_good_snapshot_id
          FROM app.review_serving_snapshot_manifest manifest
          WHERE manifest.snapshot_status = 'active'
        ),
        protected_selected_import_snapshot AS (
          SELECT
            project_id,
            selected_import_snapshot_id
          FROM active_manifest
          WHERE selected_import_snapshot_id IS NOT NULL
          UNION
          SELECT
            active_manifest.project_id,
            last_known_good_manifest.selected_import_snapshot_id
          FROM active_manifest
          INNER JOIN app.review_serving_snapshot_manifest last_known_good_manifest
            ON last_known_good_manifest.project_id = active_manifest.project_id
            AND last_known_good_manifest.snapshot_id = active_manifest.last_known_good_snapshot_id
          WHERE last_known_good_manifest.selected_import_snapshot_id IS NOT NULL
        ),
        selected_base AS (
          SELECT
            raw_selected_base.*,
            COALESCE(selected_import_snapshot.status, 'missing-selected-import-snapshot') AS snapshot_status,
            protected_selected_import_snapshot.selected_import_snapshot_id IS NOT NULL AS active_or_last_known_good_protected
          FROM mart.review_selected_article_import_current_v4 raw_selected_base
          LEFT JOIN app.review_selected_import_snapshot selected_import_snapshot
            ON selected_import_snapshot.project_id = raw_selected_base.project_id
            AND selected_import_snapshot.project_scope_identity = raw_selected_base.project_scope_identity
            AND selected_import_snapshot.selected_import_snapshot_id = raw_selected_base.selected_import_snapshot_id
          LEFT JOIN protected_selected_import_snapshot
            ON protected_selected_import_snapshot.project_id = raw_selected_base.project_id
            AND protected_selected_import_snapshot.selected_import_snapshot_id = raw_selected_base.selected_import_snapshot_id
        ),
        selected_with_hot AS (
          SELECT
            selected_base.*,
            hot_field.source_record_key IS NOT NULL AS hot_resolved,
            hot_field.duplicate_flag AS hot_duplicate_flag,
            hot_field.conflict_flag AS hot_conflict_flag
          FROM selected_base
          LEFT JOIN app.review_import_article_hot_field hot_field
            ON hot_field.import_route_id = selected_base.import_route_id
            AND hot_field.article_id = selected_base.article_id
            AND hot_field.source_record_key = selected_base.source_record_key
        )
        SELECT
          snapshot_status AS snapshotStatus,
          active_or_last_known_good_protected AS activeOrLastKnownGoodProtected,
          CAST(COUNT(*) AS BIGINT) AS rowCount,
          CAST(COUNT(*) FILTER (WHERE active_or_last_known_good_protected) AS BIGINT) AS activeOrLastKnownGoodRows,
          CAST(COUNT(*) FILTER (WHERE snapshot_status = 'candidate') AS BIGINT) AS candidateRows,
          CAST(COUNT(*) FILTER (WHERE NOT active_or_last_known_good_protected AND snapshot_status <> 'candidate') AS BIGINT) AS otherRows,
          CAST(COUNT(*) FILTER (WHERE hot_resolved) AS BIGINT) AS hotResolvedRows,
          CAST(COUNT(*) FILTER (WHERE NOT hot_resolved) AS BIGINT) AS missingHotRows,
          CAST(COUNT(*) FILTER (WHERE ${selectedBaseDuplicateFlagSql} = TRUE) AS BIGINT) AS selectedBaseDuplicateTrueRows,
          CAST(COUNT(*) FILTER (WHERE ${selectedBaseConflictFlagSql} = TRUE) AS BIGINT) AS selectedBaseConflictTrueRows,
          CAST(COUNT(*) FILTER (WHERE hot_duplicate_flag = TRUE) AS BIGINT) AS hotDuplicateTrueRows,
          CAST(COUNT(*) FILTER (WHERE hot_conflict_flag = TRUE) AS BIGINT) AS hotConflictTrueRows,
          CAST(COUNT(*) FILTER (WHERE ${selectedBaseDuplicateFlagSql} IS DISTINCT FROM hot_duplicate_flag) AS BIGINT) AS duplicateMismatchRows,
          CAST(COUNT(*) FILTER (WHERE ${selectedBaseConflictFlagSql} IS DISTINCT FROM hot_conflict_flag) AS BIGINT) AS conflictMismatchRows,
          CAST(COUNT(*) FILTER (WHERE NOT hot_resolved AND ${selectedBaseDuplicateFlagSql} = TRUE) AS BIGINT) AS selectedBaseTrueDuplicateRowsWithoutHot,
          CAST(COUNT(*) FILTER (WHERE NOT hot_resolved AND ${selectedBaseConflictFlagSql} = TRUE) AS BIGINT) AS selectedBaseTrueConflictRowsWithoutHot,
          CAST(COUNT(*) FILTER (WHERE NOT hot_resolved AND COALESCE(${selectedBaseDuplicateFlagSql}, FALSE) = FALSE) AS BIGINT) AS selectedBaseFalseOrDefaultDuplicateRowsWithoutHot,
          CAST(COUNT(*) FILTER (WHERE NOT hot_resolved AND COALESCE(${selectedBaseConflictFlagSql}, FALSE) = FALSE) AS BIGINT) AS selectedBaseFalseOrDefaultConflictRowsWithoutHot
        FROM selected_with_hot
        GROUP BY 1, 2
        ORDER BY COUNT(*) DESC, snapshot_status, active_or_last_known_good_protected DESC
      `,
    )
    const selectedBaseRow = selectedBaseRows[0] ?? {}
    const hotFieldRow = hotFieldRows[0] ?? {}
    const globalDisplayCopyTotals = globalDisplayCopyRows.reduce(
      (totals, row) => {
        totals.totalRows += Number(row.rowCount ?? 0)
        totals.activeOrLastKnownGoodRows += Number(row.activeOrLastKnownGoodRows ?? 0)
        totals.candidateRows += Number(row.candidateRows ?? 0)
        totals.otherRows += Number(row.otherRows ?? 0)

        for (const column of selectedImportDisplayCopyColumns) {
          if (selectedBaseColumnNames.has(column)) {
            totals.nullCounts[column] += Number(row[`${column}_nullCount`] ?? 0)
            totals.nonNullCounts[column] += Number(row[`${column}_nonNullCount`] ?? 0)
          }
        }

        return totals
      },
      {
        activeOrLastKnownGoodRows: 0,
        candidateRows: 0,
        nonNullCounts: Object.fromEntries(
          selectedImportDisplayCopyColumns.map((column) => {
            return [column, 0]
          }),
        ) as Record<(typeof selectedImportDisplayCopyColumns)[number], number>,
        nullCounts: Object.fromEntries(
          selectedImportDisplayCopyColumns.map((column) => {
            return [column, 0]
          }),
        ) as Record<(typeof selectedImportDisplayCopyColumns)[number], number>,
        otherRows: 0,
        totalRows: 0,
      },
    )
    const selectedImportDisplayCopyGlobalEvidence: SelectedImportDisplayCopyGlobalEvidence = {
      activeOrLastKnownGoodRows: globalDisplayCopyTotals.activeOrLastKnownGoodRows,
      candidateRows: globalDisplayCopyTotals.candidateRows,
      columns: selectedImportDisplayCopyColumns.map((column) => {
        return {
          column,
          nonNullCount: selectedBaseColumnNames.has(column) ? globalDisplayCopyTotals.nonNullCounts[column] : null,
          nullCount: selectedBaseColumnNames.has(column) ? globalDisplayCopyTotals.nullCounts[column] : null,
          status: selectedBaseColumnNames.has(column) ? 'active' : 'retired/dropped',
        }
      }),
      otherRows: globalDisplayCopyTotals.otherRows,
      rows: globalDisplayCopyRows.map((row) => {
        return {
          activeOrLastKnownGoodProtected: Boolean(row.activeOrLastKnownGoodProtected),
          candidateRows: Number(row.candidateRows ?? 0),
          nonNullCounts: Object.fromEntries(
            selectedImportDisplayCopyColumns.map((column) => {
              return [column, selectedBaseColumnNames.has(column) ? Number(row[`${column}_nonNullCount`] ?? 0) : null]
            }),
          ) as Record<(typeof selectedImportDisplayCopyColumns)[number], number | null>,
          nullCounts: Object.fromEntries(
            selectedImportDisplayCopyColumns.map((column) => {
              return [column, selectedBaseColumnNames.has(column) ? Number(row[`${column}_nullCount`] ?? 0) : null]
            }),
          ) as Record<(typeof selectedImportDisplayCopyColumns)[number], number | null>,
          otherRows: Number(row.otherRows ?? 0),
          rowCount: Number(row.rowCount ?? 0),
          snapshotStatus: String(row.snapshotStatus ?? 'NULL'),
        }
      }),
      totalRows: globalDisplayCopyTotals.totalRows,
    }
    const duplicateConflictTotals = duplicateConflictRows.reduce<SelectedImportDuplicateConflictGlobalTotals>(
      (totals, row) => {
        totals.totalRows += Number(row.rowCount ?? 0)
        totals.activeOrLastKnownGoodRows += Number(row.activeOrLastKnownGoodRows ?? 0)
        totals.candidateRows += Number(row.candidateRows ?? 0)
        totals.otherRows += Number(row.otherRows ?? 0)
        totals.hotResolvedRows += Number(row.hotResolvedRows ?? 0)
        totals.missingHotRows += Number(row.missingHotRows ?? 0)
        totals.selectedBaseDuplicateTrueRows += Number(row.selectedBaseDuplicateTrueRows ?? 0)
        totals.selectedBaseConflictTrueRows += Number(row.selectedBaseConflictTrueRows ?? 0)
        totals.hotDuplicateTrueRows += Number(row.hotDuplicateTrueRows ?? 0)
        totals.hotConflictTrueRows += Number(row.hotConflictTrueRows ?? 0)
        totals.duplicateMismatchRows += Number(row.duplicateMismatchRows ?? 0)
        totals.conflictMismatchRows += Number(row.conflictMismatchRows ?? 0)
        totals.selectedBaseTrueDuplicateRowsWithoutHot += Number(row.selectedBaseTrueDuplicateRowsWithoutHot ?? 0)
        totals.selectedBaseTrueConflictRowsWithoutHot += Number(row.selectedBaseTrueConflictRowsWithoutHot ?? 0)
        totals.selectedBaseFalseOrDefaultDuplicateRowsWithoutHot += Number(
          row.selectedBaseFalseOrDefaultDuplicateRowsWithoutHot ?? 0,
        )
        totals.selectedBaseFalseOrDefaultConflictRowsWithoutHot += Number(
          row.selectedBaseFalseOrDefaultConflictRowsWithoutHot ?? 0,
        )

        return totals
      },
      {
        activeOrLastKnownGoodRows: 0,
        candidateRows: 0,
        conflictMismatchRows: 0,
        duplicateMismatchRows: 0,
        hotConflictTrueRows: 0,
        hotDuplicateTrueRows: 0,
        hotResolvedRows: 0,
        missingHotRows: 0,
        otherRows: 0,
        selectedBaseConflictTrueRows: 0,
        selectedBaseDuplicateTrueRows: 0,
        selectedBaseFalseOrDefaultConflictRowsWithoutHot: 0,
        selectedBaseFalseOrDefaultDuplicateRowsWithoutHot: 0,
        selectedBaseTrueConflictRowsWithoutHot: 0,
        selectedBaseTrueDuplicateRowsWithoutHot: 0,
        totalRows: 0,
      },
    )
    const selectedImportDuplicateConflictGlobalEvidence: SelectedImportDuplicateConflictGlobalEvidence = {
      ...duplicateConflictTotals,
      conflictFlagStatus,
      duplicateFlagStatus,
      note: 'Duplicate/conflict evidence is read-only fallback readiness only. Hot rows are resolved from retained selected-base identity `(import_route_id, article_id, source_record_key)`. `IS DISTINCT FROM` mismatches include unresolved hot rows where hot flags are NULL while the selected-base/default side provides TRUE/FALSE or default FALSE fallback values. Hot-field/default fallback semantics and retained selected-base identity remain required when hot rows do not resolve. Selected-base flag columns may already be retired/dropped; this is not schema removal authorization.',
      rows: duplicateConflictRows.map((row) => {
        return {
          activeOrLastKnownGoodProtected: Boolean(row.activeOrLastKnownGoodProtected),
          candidateRows: Number(row.candidateRows ?? 0),
          conflictMismatchRows: Number(row.conflictMismatchRows ?? 0),
          duplicateMismatchRows: Number(row.duplicateMismatchRows ?? 0),
          hotConflictTrueRows: Number(row.hotConflictTrueRows ?? 0),
          hotDuplicateTrueRows: Number(row.hotDuplicateTrueRows ?? 0),
          hotResolvedRows: Number(row.hotResolvedRows ?? 0),
          missingHotRows: Number(row.missingHotRows ?? 0),
          otherRows: Number(row.otherRows ?? 0),
          rowCount: Number(row.rowCount ?? 0),
          selectedBaseConflictTrueRows: Number(row.selectedBaseConflictTrueRows ?? 0),
          selectedBaseDuplicateTrueRows: Number(row.selectedBaseDuplicateTrueRows ?? 0),
          selectedBaseFalseOrDefaultConflictRowsWithoutHot: Number(
            row.selectedBaseFalseOrDefaultConflictRowsWithoutHot ?? 0,
          ),
          selectedBaseFalseOrDefaultDuplicateRowsWithoutHot: Number(
            row.selectedBaseFalseOrDefaultDuplicateRowsWithoutHot ?? 0,
          ),
          selectedBaseTrueConflictRowsWithoutHot: Number(row.selectedBaseTrueConflictRowsWithoutHot ?? 0),
          selectedBaseTrueDuplicateRowsWithoutHot: Number(row.selectedBaseTrueDuplicateRowsWithoutHot ?? 0),
          snapshotStatus: String(row.snapshotStatus ?? 'NULL'),
        }
      }),
    }

    return {
      activeOrLastKnownGoodSelectedImportRows: getNumberOrNull(selectedBaseRow.activeOrLastKnownGoodSelectedImportRows),
      candidateSelectedImportRows: getNumberOrNull(selectedBaseRow.candidateSelectedImportRows),
      columns: selectedImportPayloadColumns.map((column) => {
        return {
          column,
          hotFieldNonNullCount: getNumberOrNull(hotFieldRow[`hotField_${column}_nonNullCount`]),
          hotFieldNullCount: getNumberOrNull(hotFieldRow[`hotField_${column}_nullCount`]),
          selectedBaseColumnStatus: selectedBaseColumnNames.has(column) ? 'active' : 'retired/dropped',
          selectedBaseActiveOrLastKnownGoodNonNullCount: getNumberOrNull(
            selectedBaseRow[`selectedBase_${column}_activeOrLastKnownGoodNonNullCount`],
          ),
          selectedBaseActiveOrLastKnownGoodNullCount: getNumberOrNull(
            selectedBaseRow[`selectedBase_${column}_activeOrLastKnownGoodNullCount`],
          ),
          selectedBaseCandidateNonNullCount: getNumberOrNull(
            selectedBaseRow[`selectedBase_${column}_candidateNonNullCount`],
          ),
          selectedBaseCandidateNullCount: getNumberOrNull(selectedBaseRow[`selectedBase_${column}_candidateNullCount`]),
          selectedBaseNonNullCount: getNumberOrNull(selectedBaseRow[`selectedBase_${column}_nonNullCount`]),
          selectedBaseOtherNonNullCount: getNumberOrNull(selectedBaseRow[`selectedBase_${column}_otherNonNullCount`]),
          selectedBaseOtherNullCount: getNumberOrNull(selectedBaseRow[`selectedBase_${column}_otherNullCount`]),
          selectedBaseNullCount: getNumberOrNull(selectedBaseRow[`selectedBase_${column}_nullCount`]),
        }
      }),
      comparisonStatus:
        'Selected-base counts are split into active/LKG protected selected-import rows, candidate selected-import rows, and other rows. Retired/dropped selected-base columns report null counts instead of binding the absent physical columns. Hot-field counts are scoped through app.project_import_route for the same project. Non-null hot-field values with null selected-base values mean source data exists but the selected-base projection did not carry it for this scoped snapshot.',
      consumerWriterStatus:
        'Current code no longer writes or consumes selected-base display-copy values for publication_year, article_title, journal_title, and external_id. Post-drop databases report those columns as retired/dropped. Selected-base identity/rank/source fields remain active runtime state.',
      error: null,
      hotFieldScopedRows: getNumberOrNull(hotFieldRow.hotFieldScopedRows),
      note: 'This section is not broad deletion/slimming authorization. It is a regression/readiness check for selected-base display-copy write suppression and the bounded display-copy schema drop; identity/rank/source fields remain active.',
      otherSelectedImportRows: getNumberOrNull(selectedBaseRow.otherSelectedImportRows),
      projectId,
      rowsBySelectedImportSnapshotStatus: snapshotStatusRows.map((row) => {
        return {label: String(row.snapshotStatus ?? 'NULL'), rowCount: Number(row.rowCount ?? 0)}
      }),
      selectedBaseScopedRows: getNumberOrNull(selectedBaseRow.selectedBaseScopedRows),
      selectedImportDuplicateConflictGlobalEvidence,
      selectedImportDisplayCopyGlobalEvidence,
      verdict: 'not-authorized',
    }
  } catch (error) {
    return {
      activeOrLastKnownGoodSelectedImportRows: null,
      candidateSelectedImportRows: null,
      columns: [],
      comparisonStatus: 'Blocked before source/hot-field comparison could be collected.',
      consumerWriterStatus:
        'Selected-import payload evidence collection failed; this cannot authorize schema slimming or deletion.',
      error: error instanceof Error ? error.message : String(error),
      hotFieldScopedRows: null,
      note: 'This section is not deletion/slimming authorization.',
      otherSelectedImportRows: null,
      projectId,
      rowsBySelectedImportSnapshotStatus: [],
      selectedBaseScopedRows: null,
      selectedImportDuplicateConflictGlobalEvidence: emptyDuplicateConflictEvidence,
      selectedImportDisplayCopyGlobalEvidence: emptyGlobalDisplayCopyEvidence,
      verdict: 'blocked',
    }
  }
}

const getDuplicateCountForColumns = async (
  runtime: QueryRuntime,
  table: string,
  keyColumns: string[],
  whereClause: string | null,
) => {
  const keySql = keyColumns
    .map((columnName) => {
      return `"${columnName}"`
    })
    .join(', ')
  const rows = await runReadonlyQuery<{duplicateCount: number | string}>(
    runtime,
    `
      WITH duplicate_keys AS (
        SELECT ${keySql}
        FROM ${table}
        ${whereClause ? `WHERE ${whereClause}` : ''}
        GROUP BY ${keySql}
        HAVING COUNT(*) > 1
      )
      SELECT CAST(COUNT(*) AS BIGINT) AS duplicateCount
      FROM duplicate_keys
    `,
  )

  return Number(rows[0]?.duplicateCount ?? 0)
}

const getSelectedImportStagingDuplicateProbe = async (
  runtime: QueryRuntime,
  table: SelectedImportStagingPhysicalEvidenceReport['table'],
  label: string,
  keyColumns: string[],
  limit: number,
): Promise<SelectedImportStagingDuplicateProbe> => {
  const keySql = keyColumns
    .map((columnName) => {
      return `"${columnName}"`
    })
    .join(', ')
  const sampleSelectSql = keyColumns
    .map((columnName) => {
      return `"${columnName}" AS "${columnName}"`
    })
    .join(', ')
  const rows = await runReadonlyQuery<Record<string, number | string | null>>(
    runtime,
    `
      WITH duplicate_keys AS (
        SELECT
          ${keySql},
          CAST(COUNT(*) AS BIGINT) AS duplicateRows
        FROM ${table}
        GROUP BY ${keySql}
        HAVING COUNT(*) > 1
      )
      SELECT
        ${sampleSelectSql},
        duplicateRows,
        CAST(COUNT(*) OVER () AS BIGINT) AS duplicateKeyCount
      FROM duplicate_keys
      ORDER BY duplicateRows DESC, ${keySql}
      LIMIT ${limit}
    `,
  )

  return {
    duplicateCount: Number(rows[0]?.duplicateKeyCount ?? 0),
    keyColumns,
    label,
    sampleRows: rows.map((row) => {
      return Object.fromEntries(
        [...keyColumns, 'duplicateRows'].map((columnName) => {
          const value = row[columnName]
          return [columnName, value === null || value === undefined ? null : typeof value === 'number' ? value : value]
        }),
      ) as Record<string, string | number | null>
    }),
  }
}

const getSelectedImportStagingPhysicalEvidenceReport = async (
  runtime: QueryRuntime,
  projectId: string,
  limit: number,
): Promise<SelectedImportStagingPhysicalEvidenceReport> => {
  const table = 'mart.review_selected_article_import_staging_v4'

  try {
    if (!(await getTableExists(runtime, table))) {
      return {
        currentProjectPublishedRows: null,
        currentProjectRows: null,
        currentProjectUnpublishedRows: null,
        duplicateProbes: [],
        error: `Table is absent: ${table}`,
        globalPublishedRows: null,
        globalRowCount: null,
        globalUnpublishedRows: null,
        note: 'Selected-import staging evidence could not be collected because the staging table is absent. Failed evidence collection is not cleanup, migration, or runtime-change authorization.',
        projectId,
        rowsByPublishState: [],
        rowsBySourcePartition: [],
        table,
        verdict: 'blocked',
      }
    }

    const totalRows = await runReadonlyQuery<Record<string, number | string | null>>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) AS BIGINT) AS globalRowCount,
          CAST(COUNT(*) FILTER (WHERE published_at IS NOT NULL) AS BIGINT) AS globalPublishedRows,
          CAST(COUNT(*) FILTER (WHERE published_at IS NULL) AS BIGINT) AS globalUnpublishedRows,
          CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows,
          CAST(COUNT(*) FILTER (
            WHERE project_id = ${getSqlLiteral(projectId)}
              AND published_at IS NOT NULL
          ) AS BIGINT) AS currentProjectPublishedRows,
          CAST(COUNT(*) FILTER (
            WHERE project_id = ${getSqlLiteral(projectId)}
              AND published_at IS NULL
          ) AS BIGINT) AS currentProjectUnpublishedRows
        FROM ${table}
      `,
    )
    const publishStateRows = await runReadonlyQuery<{
      currentProjectRows: number | string
      publishState: 'published' | 'unpublished'
      rowCount: number | string
    }>(
      runtime,
      `
        SELECT
          CASE WHEN published_at IS NULL THEN 'unpublished' ELSE 'published' END AS publishState,
          CAST(COUNT(*) AS BIGINT) AS rowCount,
          CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows
        FROM ${table}
        GROUP BY 1
        ORDER BY publishState
      `,
    )
    const sourcePartitionRows = await runReadonlyQuery<{
      currentProjectRows: number | string
      publishedRows: number | string
      rowCount: number | string
      sourcePartition: string | null
      unpublishedRows: number | string
    }>(
      runtime,
      `
        SELECT
          source_partition AS sourcePartition,
          CAST(COUNT(*) AS BIGINT) AS rowCount,
          CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows,
          CAST(COUNT(*) FILTER (WHERE published_at IS NOT NULL) AS BIGINT) AS publishedRows,
          CAST(COUNT(*) FILTER (WHERE published_at IS NULL) AS BIGINT) AS unpublishedRows
        FROM ${table}
        GROUP BY 1
        ORDER BY COUNT(*) DESC, source_partition
        LIMIT ${limit}
      `,
    )
    const row = totalRows[0] ?? {}

    return {
      currentProjectPublishedRows: getNumberOrNull(row.currentProjectPublishedRows),
      currentProjectRows: getNumberOrNull(row.currentProjectRows),
      currentProjectUnpublishedRows: getNumberOrNull(row.currentProjectUnpublishedRows),
      duplicateProbes: [
        await getSelectedImportStagingDuplicateProbe(runtime, table, 'staging row id', ['staging_row_id'], limit),
        await getSelectedImportStagingDuplicateProbe(
          runtime,
          table,
          'publish identity',
          ['project_id', 'project_scope_identity', 'selected_import_snapshot_id', 'article_id', 'publish_scope_key'],
          limit,
        ),
      ],
      error: null,
      globalPublishedRows: getNumberOrNull(row.globalPublishedRows),
      globalRowCount: getNumberOrNull(row.globalRowCount),
      globalUnpublishedRows: getNumberOrNull(row.globalUnpublishedRows),
      note: 'Selected-import staging evidence is read-only. Duplicate probes report duplicate key groups, not duplicate row totals, and sample rows are capped by --limit. Published/unpublished counts use published_at nullness and do not authorize cleanup or runtime behavior changes.',
      projectId,
      rowsByPublishState: publishStateRows.map((stateRow) => {
        return {
          currentProjectRows: Number(stateRow.currentProjectRows ?? 0),
          publishState: stateRow.publishState,
          rowCount: Number(stateRow.rowCount ?? 0),
        }
      }),
      rowsBySourcePartition: sourcePartitionRows.map((partitionRow) => {
        return {
          currentProjectRows: Number(partitionRow.currentProjectRows ?? 0),
          publishedRows: Number(partitionRow.publishedRows ?? 0),
          rowCount: Number(partitionRow.rowCount ?? 0),
          sourcePartition: String(partitionRow.sourcePartition ?? 'NULL'),
          unpublishedRows: Number(partitionRow.unpublishedRows ?? 0),
        }
      }),
      table,
      verdict: 'not-authorized',
    }
  } catch (error) {
    return {
      currentProjectPublishedRows: null,
      currentProjectRows: null,
      currentProjectUnpublishedRows: null,
      duplicateProbes: [],
      error: error instanceof Error ? error.message : String(error),
      globalPublishedRows: null,
      globalRowCount: null,
      globalUnpublishedRows: null,
      note: 'Selected-import staging evidence collection failed. Failed evidence collection is not cleanup, migration, or runtime-change authorization.',
      projectId,
      rowsByPublishState: [],
      rowsBySourcePartition: [],
      table,
      verdict: 'blocked',
    }
  }
}

const getSummaryContributionServingGroupedRows = async (
  runtime: QueryRuntime,
  table: string,
  expression: string,
  alias: string,
  limit: number | null,
) => {
  const rows = await runReadonlyQuery<Record<string, number | string | null>>(
    runtime,
    `
      SELECT ${expression} AS "${alias}", CAST(COUNT(*) AS BIGINT) AS rowCount
      FROM ${table}
      GROUP BY 1
      HAVING COUNT(*) > 0
      ORDER BY COUNT(*) DESC, "${alias}"
      ${limit === null ? '' : `LIMIT ${Math.max(1, limit)}`}
    `,
  )

  return rows.map((row) => {
    return {label: String(row[alias] ?? 'NULL'), rowCount: Number(row.rowCount ?? 0)}
  })
}

const getSummaryContributionServingAggregateRecoverability = async (
  runtime: QueryRuntime,
  summaryKind: 'count' | 'facet',
): Promise<SummaryContributionServingAggregateRecoverability> => {
  const finalRowsCte =
    summaryKind === 'count'
      ? `
        SELECT
          project_id,
          review_config_hash,
          snapshot_id,
          summary_identity,
          COALESCE(list_mode_key, 'global') AS list_mode_key,
          count_kind,
          summary_definition_version,
          filter_key,
          NULL::VARCHAR AS facet_kind,
          NULL::VARCHAR AS facet_key,
          NULL::VARCHAR AS facet_value,
          count_value
        FROM mart.review_article_count_serving_v4
      `
      : `
        SELECT
          project_id,
          review_config_hash,
          snapshot_id,
          summary_identity,
          NULL::VARCHAR AS list_mode_key,
          NULL::VARCHAR AS count_kind,
          summary_definition_version,
          NULL::VARCHAR AS filter_key,
          facet_kind,
          facet_key,
          facet_value,
          count_value
        FROM mart.review_filter_facet_serving_v4
      `
  const joinPredicate =
    summaryKind === 'count'
      ? `contribution_groups.project_id = final_rows.project_id
        AND contribution_groups.review_config_hash = final_rows.review_config_hash
        AND contribution_groups.snapshot_id = final_rows.snapshot_id
        AND contribution_groups.summary_identity = final_rows.summary_identity
        AND contribution_groups.list_mode_key = final_rows.list_mode_key
        AND contribution_groups.count_kind = final_rows.count_kind
        AND contribution_groups.summary_definition_version = final_rows.summary_definition_version
        AND contribution_groups.filter_key = final_rows.filter_key`
      : `contribution_groups.project_id = final_rows.project_id
        AND contribution_groups.review_config_hash = final_rows.review_config_hash
        AND contribution_groups.snapshot_id = final_rows.snapshot_id
        AND contribution_groups.summary_identity = final_rows.summary_identity
        AND contribution_groups.summary_definition_version = final_rows.summary_definition_version
        AND contribution_groups.facet_kind = final_rows.facet_kind
        AND contribution_groups.facet_key = final_rows.facet_key
        AND contribution_groups.facet_value = final_rows.facet_value`

  try {
    const rows = await runReadonlyQuery<{
      contributionGroups: number | string
      finalRows: number | string
      finalRowsMissingContributionGroup: number | string
      matchedFinalRows: number | string
      missingFinalRows: number | string
      mismatchedFinalRows: number | string
    }>(
      runtime,
      `
        WITH contribution_groups AS (
          SELECT
            project_id,
            review_config_hash,
            snapshot_id,
            json_extract_string(contribution_key, '$.summaryIdentity') AS summary_identity,
            COALESCE(json_extract_string(contribution_key, '$.listModeKey'), 'global') AS list_mode_key,
            json_extract_string(contribution_key, '$.countKind') AS count_kind,
            summary_definition_version,
            json_extract_string(contribution_key, '$.filterKey') AS filter_key,
            json_extract_string(contribution_key, '$.facetKind') AS facet_kind,
            json_extract_string(contribution_key, '$.facetKey') AS facet_key,
            json_extract_string(contribution_key, '$.facetValue') AS facet_value,
            SUM(COALESCE(contribution_value, 0)) AS contribution_count_value
          FROM mart.review_article_summary_contribution_v4
          WHERE json_extract_string(contribution_key, '$.summaryKind') = ${getSqlLiteral(summaryKind)}
          GROUP BY
            project_id,
            review_config_hash,
            snapshot_id,
            json_extract_string(contribution_key, '$.summaryIdentity'),
            COALESCE(json_extract_string(contribution_key, '$.listModeKey'), 'global'),
            json_extract_string(contribution_key, '$.countKind'),
            summary_definition_version,
            json_extract_string(contribution_key, '$.filterKey'),
            json_extract_string(contribution_key, '$.facetKind'),
            json_extract_string(contribution_key, '$.facetKey'),
            json_extract_string(contribution_key, '$.facetValue')
        ),
        final_rows AS (${finalRowsCte}),
        joined AS (
          SELECT
            contribution_groups.contribution_count_value,
            final_rows.count_value,
            contribution_groups.project_id IS NOT NULL AS has_contribution_group,
            final_rows.project_id IS NOT NULL AS has_final_row
          FROM contribution_groups
          FULL OUTER JOIN final_rows
            ON ${joinPredicate}
        )
        SELECT
          CAST(COUNT(*) FILTER (WHERE has_contribution_group) AS BIGINT) AS contributionGroups,
          CAST(COUNT(*) FILTER (WHERE has_final_row) AS BIGINT) AS finalRows,
          CAST(COUNT(*) FILTER (
            WHERE has_contribution_group
              AND has_final_row
              AND contribution_count_value IS NOT DISTINCT FROM count_value
          ) AS BIGINT) AS matchedFinalRows,
          CAST(COUNT(*) FILTER (WHERE has_contribution_group AND NOT has_final_row) AS BIGINT) AS missingFinalRows,
          CAST(COUNT(*) FILTER (
            WHERE has_contribution_group
              AND has_final_row
              AND NOT (contribution_count_value IS NOT DISTINCT FROM count_value)
          ) AS BIGINT) AS mismatchedFinalRows,
          CAST(COUNT(*) FILTER (WHERE has_final_row AND NOT has_contribution_group) AS BIGINT) AS finalRowsMissingContributionGroup
        FROM joined
      `,
    )
    const row = rows[0]

    return {
      contributionGroups: getNumberOrNull(row?.contributionGroups),
      error: null,
      finalRows: getNumberOrNull(row?.finalRows),
      finalRowsMissingContributionGroup: getNumberOrNull(row?.finalRowsMissingContributionGroup),
      matchedFinalRows: getNumberOrNull(row?.matchedFinalRows),
      missingFinalRows: getNumberOrNull(row?.missingFinalRows),
      mismatchedFinalRows: getNumberOrNull(row?.mismatchedFinalRows),
      note: 'Read-only aggregate comparison between contribution_key groups and final serving rows. Matches prove only aggregate count parity for this snapshot, not recoverability of exact per-article ledger rows.',
      summaryKind,
    }
  } catch (error) {
    return {
      contributionGroups: null,
      error: error instanceof Error ? error.message : String(error),
      finalRows: null,
      finalRowsMissingContributionGroup: null,
      matchedFinalRows: null,
      missingFinalRows: null,
      mismatchedFinalRows: null,
      note: 'Aggregate serving comparison failed; failed evidence collection is not deletion authorization.',
      summaryKind,
    }
  }
}

const getSummaryContributionPartialOverlap = async (
  runtime: QueryRuntime,
): Promise<SummaryContributionServingPartialOverlap> => {
  try {
    if (!(await getTableExists(runtime, 'mart.review_article_summary_contribution_rebuild_partial_v4'))) {
      return {
        contributionRows: null,
        error: null,
        exactCommonColumnOverlapRows: null,
        note: 'Retired by migration 0176_dropReviewSummaryContributionRebuildPartial.sql; no rebuild-partial contribution overlap was collected.',
        partialRows: null,
        partialRowsWithExactCommonContribution: null,
      }
    }

    const rows = await runReadonlyQuery<{
      contributionRows: number | string
      exactCommonColumnOverlapRows: number | string
      partialRows: number | string
      partialRowsWithExactCommonContribution: number | string
    }>(
      runtime,
      `
        WITH contribution_rows AS (
          SELECT
            project_id,
            review_config_hash,
            snapshot_id,
            article_id,
            component_kind,
            summary_definition_version,
            json_extract_string(contribution_key, '$.summaryKind') AS summary_kind,
            json_extract_string(contribution_key, '$.summaryIdentity') AS summary_identity,
            COALESCE(json_extract_string(contribution_key, '$.listModeKey'), 'global') AS list_mode_key,
            json_extract_string(contribution_key, '$.countKind') AS count_kind,
            json_extract_string(contribution_key, '$.filterKey') AS filter_key,
            json_extract_string(contribution_key, '$.facetKind') AS facet_kind,
            json_extract_string(contribution_key, '$.facetKey') AS facet_key,
            json_extract_string(contribution_key, '$.facetValue') AS facet_value,
            contribution_value
          FROM mart.review_article_summary_contribution_v4
        )
        SELECT
          CAST((SELECT COUNT(*) FROM mart.review_article_summary_contribution_v4) AS BIGINT) AS contributionRows,
          CAST((SELECT COUNT(*) FROM mart.review_article_summary_contribution_rebuild_partial_v4) AS BIGINT) AS partialRows,
          CAST((
            SELECT COUNT(*)
            FROM contribution_rows contribution
            WHERE EXISTS (
              SELECT 1
              FROM mart.review_article_summary_contribution_rebuild_partial_v4 partial
              WHERE partial.project_id = contribution.project_id
                AND partial.review_config_hash = contribution.review_config_hash
                AND partial.snapshot_id = contribution.snapshot_id
                AND partial.article_id = contribution.article_id
                AND partial.component_kind = contribution.component_kind
                AND partial.summary_definition_version = contribution.summary_definition_version
                AND partial.summary_kind = contribution.summary_kind
                AND partial.summary_identity = contribution.summary_identity
                AND COALESCE(partial.list_mode_key, 'global') = contribution.list_mode_key
                AND partial.count_kind IS NOT DISTINCT FROM contribution.count_kind
                AND partial.filter_key IS NOT DISTINCT FROM contribution.filter_key
                AND partial.facet_kind IS NOT DISTINCT FROM contribution.facet_kind
                AND partial.facet_key IS NOT DISTINCT FROM contribution.facet_key
                AND partial.facet_value IS NOT DISTINCT FROM contribution.facet_value
                AND partial.contribution_value = contribution.contribution_value
            )
          ) AS BIGINT) AS exactCommonColumnOverlapRows,
          CAST((
            SELECT COUNT(*)
            FROM mart.review_article_summary_contribution_rebuild_partial_v4 partial
            WHERE EXISTS (
              SELECT 1
              FROM contribution_rows contribution
              WHERE contribution.project_id = partial.project_id
                AND contribution.review_config_hash = partial.review_config_hash
                AND contribution.snapshot_id = partial.snapshot_id
                AND contribution.article_id = partial.article_id
                AND contribution.component_kind = partial.component_kind
                AND contribution.summary_definition_version = partial.summary_definition_version
                AND contribution.summary_kind = partial.summary_kind
                AND contribution.summary_identity = partial.summary_identity
                AND contribution.list_mode_key = COALESCE(partial.list_mode_key, 'global')
                AND contribution.count_kind IS NOT DISTINCT FROM partial.count_kind
                AND contribution.filter_key IS NOT DISTINCT FROM partial.filter_key
                AND contribution.facet_kind IS NOT DISTINCT FROM partial.facet_kind
                AND contribution.facet_key IS NOT DISTINCT FROM partial.facet_key
                AND contribution.facet_value IS NOT DISTINCT FROM partial.facet_value
                AND contribution.contribution_value = partial.contribution_value
            )
          ) AS BIGINT) AS partialRowsWithExactCommonContribution
      `,
    )
    const row = rows[0]

    return {
      contributionRows: getNumberOrNull(row?.contributionRows),
      error: null,
      exactCommonColumnOverlapRows: getNumberOrNull(row?.exactCommonColumnOverlapRows),
      note: 'Exact overlap compares the shared logical contribution identity and value columns, excluding request/chunk ownership and timestamps. The final aggregate count/facet rows do not contain article_id/component_kind/contribution_key rows and cannot reconstruct exact per-article contribution ledger rows.',
      partialRows: getNumberOrNull(row?.partialRows),
      partialRowsWithExactCommonContribution: getNumberOrNull(row?.partialRowsWithExactCommonContribution),
    }
  } catch (error) {
    return {
      contributionRows: null,
      error: error instanceof Error ? error.message : String(error),
      exactCommonColumnOverlapRows: null,
      note: 'Exact rebuild-partial overlap collection failed; failed evidence collection is not deletion authorization.',
      partialRows: null,
      partialRowsWithExactCommonContribution: null,
    }
  }
}

const getSummaryContributionServingReadinessReport = async (
  runtime: QueryRuntime,
  limit: number,
): Promise<SummaryContributionServingReadinessReport> => {
  const table = 'mart.review_article_summary_contribution_v4' as const
  const primaryKeyColumns = [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'article_id',
    'component_kind',
    'summary_definition_version',
    'contribution_key',
  ]
  const lookupIndexColumns = [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'component_kind',
    'summary_definition_version',
    'contribution_key',
  ]

  try {
    if (!(await getTableExists(runtime, table))) {
      return {
        activeOrLastKnownGoodSnapshotProtectedRows: null,
        columnCount: null,
        columns: [],
        duplicateProbes: [],
        error: null,
        globalRowCount: null,
        indexes: [],
        missingSnapshotManifestRows: null,
        nonzeroProjectCount: null,
        note: 'Retired by migration 0141_dropReviewSummaryContributionServing.sql; no row, duplicate, index, or recoverability inspection was attempted for the dropped serving ledger.',
        partialRebuildOverlap: {
          contributionRows: null,
          error: null,
          exactCommonColumnOverlapRows: null,
          note: 'Not collected because mart.review_article_summary_contribution_v4 is retired. The request-scoped contribution partial table is also retired by migration 0176.',
          partialRows: null,
          partialRowsWithExactCommonContribution: null,
        },
        pinnedSnapshotRows: null,
        recoverabilityClassification:
          'retired: mart.review_article_summary_contribution_v4 is expected to be absent after migration 0141; this report does not pretend rows were inspected.',
        recoverabilityComparisons: [],
        rowsByComponentKind: [],
        rowsByProject: [],
        rowsBySnapshotStatus: [],
        rowsBySummaryDefinitionVersion: [],
        table,
        topContributionKeys: [],
        topProjects: [],
        verdict: 'retired',
      }
    }

    const columns = await getTableColumns(runtime, table)
    const manifestColumns = await getTableColumns(runtime, 'app.review_serving_snapshot_manifest')
    const hasSnapshotStatus = hasColumn(manifestColumns, 'snapshot_status')
    const countRows = await runReadonlyQuery<{
      activeOrLastKnownGoodSnapshotProtectedRows: number | string
      globalRowCount: number | string
      missingSnapshotManifestRows: number | string
      nonzeroProjectCount: number | string
      pinnedSnapshotRows: number | string
    }>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) FILTER (WHERE ${getActiveSnapshotManifestGuardPredicate('snapshot_id')}) AS BIGINT) AS activeOrLastKnownGoodSnapshotProtectedRows,
          CAST(COUNT(*) FILTER (WHERE ${getActiveSnapshotPinGuardPredicate('snapshot_id')}) AS BIGINT) AS pinnedSnapshotRows,
          CAST(COUNT(*) FILTER (
            WHERE NOT EXISTS (
              SELECT 1
              FROM app.review_serving_snapshot_manifest manifest
              WHERE manifest.project_id = candidate.project_id
                AND manifest.snapshot_id = candidate.snapshot_id
            )
          ) AS BIGINT) AS missingSnapshotManifestRows,
          CAST(COUNT(*) AS BIGINT) AS globalRowCount,
          CAST(COUNT(DISTINCT project_id) AS BIGINT) AS nonzeroProjectCount
        FROM ${table} candidate
      `,
    )
    const topProjects = await runReadonlyQuery<{projectId: string; rowCount: number | string}>(
      runtime,
      `
        SELECT project_id AS projectId, CAST(COUNT(*) AS BIGINT) AS rowCount
        FROM ${table}
        GROUP BY project_id
        HAVING COUNT(*) > 0
        ORDER BY COUNT(*) DESC, project_id
        LIMIT ${Math.max(1, limit)}
      `,
    )
    const rowsBySnapshotStatus = hasSnapshotStatus
      ? await getSummaryContributionServingGroupedRows(
          runtime,
          `
            ${table} contribution
            LEFT JOIN app.review_serving_snapshot_manifest manifest
              ON manifest.project_id = contribution.project_id
              AND manifest.snapshot_id = contribution.snapshot_id
          `,
          "COALESCE(manifest.snapshot_status, 'missing-manifest')",
          'snapshotStatus',
          null,
        )
      : []

    return {
      activeOrLastKnownGoodSnapshotProtectedRows: getNumberOrNull(
        countRows[0]?.activeOrLastKnownGoodSnapshotProtectedRows,
      ),
      columnCount: columns.length,
      columns,
      duplicateProbes: [
        {
          duplicateCount: await getDuplicateCountForColumns(runtime, table, primaryKeyColumns, null),
          keyColumns: primaryKeyColumns,
          label: 'declared primary key',
        },
        {
          duplicateCount: await getDuplicateCountForColumns(runtime, table, lookupIndexColumns, null),
          keyColumns: lookupIndexColumns,
          label: 'lookup index key without article_id',
        },
      ],
      error: null,
      globalRowCount: getNumberOrNull(countRows[0]?.globalRowCount),
      indexes: await getIndexes(runtime, table),
      missingSnapshotManifestRows: getNumberOrNull(countRows[0]?.missingSnapshotManifestRows),
      nonzeroProjectCount: getNumberOrNull(countRows[0]?.nonzeroProjectCount),
      note: 'Read-only current-DB snapshot evidence for the summary contribution serving ledger beyond the default scoped project. This section is not deletion authorization; table removal still requires route parity, benchmark, recovery, and live progress proof.',
      partialRebuildOverlap: await getSummaryContributionPartialOverlap(runtime),
      pinnedSnapshotRows: getNumberOrNull(countRows[0]?.pinnedSnapshotRows),
      recoverabilityClassification:
        'bounded-readonly-aggregate-only: final count/facet serving rows can be compared to contribution_key aggregate groups, but final aggregate rows cannot reconstruct exact per-article contribution ledger rows and this report does not authorize deletion.',
      recoverabilityComparisons: [
        await getSummaryContributionServingAggregateRecoverability(runtime, 'count'),
        await getSummaryContributionServingAggregateRecoverability(runtime, 'facet'),
      ],
      rowsByComponentKind: await getSummaryContributionServingGroupedRows(
        runtime,
        table,
        'component_kind',
        'componentKind',
        null,
      ),
      rowsByProject: topProjects.map((row) => {
        return {label: row.projectId, projectId: row.projectId, rowCount: Number(row.rowCount)}
      }),
      rowsBySnapshotStatus,
      rowsBySummaryDefinitionVersion: await getSummaryContributionServingGroupedRows(
        runtime,
        table,
        'summary_definition_version',
        'summaryDefinitionVersion',
        null,
      ),
      table,
      topContributionKeys: await getSummaryContributionServingGroupedRows(
        runtime,
        table,
        'contribution_key',
        'contributionKey',
        limit,
      ),
      topProjects: topProjects.map((row) => {
        return {projectId: row.projectId, rowCount: Number(row.rowCount)}
      }),
      verdict: 'not-authorized',
    }
  } catch (error) {
    return {
      activeOrLastKnownGoodSnapshotProtectedRows: null,
      columnCount: null,
      columns: [],
      duplicateProbes: [],
      error: error instanceof Error ? error.message : String(error),
      globalRowCount: null,
      indexes: [],
      missingSnapshotManifestRows: null,
      nonzeroProjectCount: null,
      note: 'Read-only current-DB snapshot evidence collection failed. Failed evidence collection is not deletion authorization.',
      partialRebuildOverlap: {
        contributionRows: null,
        error: null,
        exactCommonColumnOverlapRows: null,
        note: 'Not collected because summary contribution serving readiness collection failed.',
        partialRows: null,
        partialRowsWithExactCommonContribution: null,
      },
      pinnedSnapshotRows: null,
      recoverabilityClassification:
        'blocked: failed evidence collection cannot classify recoverability or authorize deletion.',
      recoverabilityComparisons: [],
      rowsByComponentKind: [],
      rowsByProject: [],
      rowsBySnapshotStatus: [],
      rowsBySummaryDefinitionVersion: [],
      table,
      topContributionKeys: [],
      topProjects: [],
      verdict: 'blocked',
    }
  }
}

const getUnassessedQueueServingReadinessReport = async (
  runtime: QueryRuntime,
  projectId: string,
  limit: number,
): Promise<UnassessedQueueServingReadinessReport> => {
  const table = 'mart.review_unassessed_queue_serving_v4' as const
  const declaredServingKeyColumns = [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'queue_kind',
    'priority_bucket',
    'activity_sort_at',
    'article_id',
  ]
  const orderKeyWithoutQueueIdentityColumns = [
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'queue_kind',
    'priority_bucket',
    'activity_sort_at',
    'article_id',
  ]
  const currentProjectWhereClause = `project_id = ${getSqlLiteral(projectId)}`

  try {
    const columns = await getTableColumns(runtime, table)
    const hasPromptIds = hasColumn(columns, 'prompt_ids')
    const hasPromptId = hasColumn(columns, 'prompt_id')
    const promptMembershipExpression = hasPromptIds
      ? 'COALESCE(array_length(prompt_ids), 0)'
      : hasPromptId
        ? 'CASE WHEN prompt_id IS NULL THEN 0 ELSE 1 END'
        : '0'
    const promptNullExpression = hasPromptIds
      ? 'COALESCE(array_length(prompt_ids), 0) = 0'
      : hasPromptId
        ? 'prompt_id IS NULL'
        : 'TRUE'
    const distinctPromptPairsSql = hasPromptIds
      ? `
          SELECT CAST(COUNT(DISTINCT article_id || ':' || prompt_id) AS BIGINT)
          FROM (
            SELECT article_id, unnest(prompt_ids) AS prompt_id
            FROM ${table}
          ) expanded_prompt_pairs
        `
      : hasPromptId
        ? `SELECT CAST(COUNT(DISTINCT article_id || ':' || COALESCE(prompt_id, '<NULL>')) AS BIGINT) FROM ${table}`
        : 'SELECT CAST(0 AS BIGINT)'
    const manifestColumns = await getTableColumns(runtime, 'app.review_serving_snapshot_manifest')
    const hasSnapshotStatus = hasColumn(manifestColumns, 'snapshot_status')
    const countRows = await runReadonlyQuery<{
      activeOrLastKnownGoodSnapshotProtectedRows: number | string
      candidateRows: number | string
      currentProjectRows: number | string
      distinctArticles: number | string
      distinctPromptPairs: number | string
      globalNonNullPromptRows: number | string
      globalNullPromptRows: number | string
      globalRowCount: number | string
      missingSnapshotManifestRows: number | string
      otherRows: number | string
      pinnedSnapshotRows: number | string
    }>(
      runtime,
      `
        WITH classified AS (
          SELECT
            candidate.*,
            ${getActiveSnapshotManifestGuardPredicate('snapshot_id')} AS active_or_last_known_good_protected,
            ${getActiveSnapshotPinGuardPredicate('snapshot_id')} AS pinned_protected,
            ${hasSnapshotStatus ? "COALESCE(manifest.snapshot_status, 'missing-manifest')" : "'unknown'"} AS snapshot_status
          FROM ${table} candidate
          LEFT JOIN app.review_serving_snapshot_manifest manifest
            ON manifest.project_id = candidate.project_id
            AND manifest.snapshot_id = candidate.snapshot_id
        )
        SELECT
          CAST(COUNT(*) AS BIGINT) AS globalRowCount,
          CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows,
          CAST(COUNT(*) FILTER (WHERE active_or_last_known_good_protected) AS BIGINT) AS activeOrLastKnownGoodSnapshotProtectedRows,
          CAST(COUNT(*) FILTER (WHERE pinned_protected) AS BIGINT) AS pinnedSnapshotRows,
          CAST(COUNT(*) FILTER (WHERE snapshot_status = 'candidate') AS BIGINT) AS candidateRows,
          CAST(COUNT(*) FILTER (WHERE NOT active_or_last_known_good_protected AND snapshot_status <> 'candidate') AS BIGINT) AS otherRows,
          CAST(COUNT(*) FILTER (WHERE snapshot_status = 'missing-manifest') AS BIGINT) AS missingSnapshotManifestRows,
          CAST(COUNT(*) FILTER (WHERE ${promptNullExpression}) AS BIGINT) AS globalNullPromptRows,
          CAST(COALESCE(SUM(${promptMembershipExpression}), 0) AS BIGINT) AS globalNonNullPromptRows,
          CAST(COUNT(DISTINCT article_id) AS BIGINT) AS distinctArticles,
          (${distinctPromptPairsSql}) AS distinctPromptPairs
        FROM classified
      `,
    )
    const promptRows = await runReadonlyQuery<{
      currentProjectNonNullPromptRows: number | string
      currentProjectNullPromptRows: number | string
    }>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) FILTER (WHERE ${promptNullExpression}) AS BIGINT) AS currentProjectNullPromptRows,
          CAST(COALESCE(SUM(${promptMembershipExpression}), 0) AS BIGINT) AS currentProjectNonNullPromptRows
        FROM ${table}
        WHERE ${currentProjectWhereClause}
      `,
    )
    const rowsByProtectionAndStatus = await runReadonlyQuery<{
      activeOrLastKnownGoodProtected: boolean
      candidateRows: number | string
      currentProjectRows: number | string
      otherRows: number | string
      pinnedProtected: boolean
      rowCount: number | string
      snapshotStatus: string | null
    }>(
      runtime,
      `
        WITH classified AS (
          SELECT
            candidate.*,
            ${getActiveSnapshotManifestGuardPredicate('snapshot_id')} AS active_or_last_known_good_protected,
            ${getActiveSnapshotPinGuardPredicate('snapshot_id')} AS pinned_protected,
            ${hasSnapshotStatus ? "COALESCE(manifest.snapshot_status, 'missing-manifest')" : "'unknown'"} AS snapshot_status
          FROM ${table} candidate
          LEFT JOIN app.review_serving_snapshot_manifest manifest
            ON manifest.project_id = candidate.project_id
            AND manifest.snapshot_id = candidate.snapshot_id
        )
        SELECT
          snapshot_status AS snapshotStatus,
          active_or_last_known_good_protected AS activeOrLastKnownGoodProtected,
          pinned_protected AS pinnedProtected,
          CAST(COUNT(*) AS BIGINT) AS rowCount,
          CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows,
          CAST(COUNT(*) FILTER (WHERE snapshot_status = 'candidate') AS BIGINT) AS candidateRows,
          CAST(COUNT(*) FILTER (WHERE NOT active_or_last_known_good_protected AND snapshot_status <> 'candidate') AS BIGINT) AS otherRows
        FROM classified
        GROUP BY snapshot_status, active_or_last_known_good_protected, pinned_protected
        HAVING COUNT(*) > 0
        ORDER BY COUNT(*) DESC, snapshot_status, active_or_last_known_good_protected DESC, pinned_protected DESC
      `,
    )
    const consumerRows = await runReadonlyQuery<Record<string, number | string>>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) FILTER (WHERE queue_kind = 'unassessed') AS BIGINT) AS routeRows,
          CAST(COALESCE(SUM(CASE WHEN queue_kind = 'unassessed' THEN ${promptMembershipExpression} ELSE 0 END), 0) AS BIGINT) AS judgmentJobPromptRows,
          CAST(COUNT(DISTINCT article_id) FILTER (WHERE queue_kind = 'unassessed') AS BIGINT) AS bulkDistinctArticleRows,
          CAST(COALESCE(SUM(CASE WHEN queue_kind = 'unassessed' THEN ${promptMembershipExpression} ELSE 0 END), 0) AS BIGINT) AS summaryPromptRows
        FROM ${table}
      `,
    )
    const currentProjectConsumerRows = await runReadonlyQuery<Record<string, number | string>>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) FILTER (WHERE queue_kind = 'unassessed') AS BIGINT) AS routeRows,
          CAST(COALESCE(SUM(CASE WHEN queue_kind = 'unassessed' THEN ${promptMembershipExpression} ELSE 0 END), 0) AS BIGINT) AS judgmentJobPromptRows,
          CAST(COUNT(DISTINCT article_id) FILTER (WHERE queue_kind = 'unassessed') AS BIGINT) AS bulkDistinctArticleRows,
          CAST(COALESCE(SUM(CASE WHEN queue_kind = 'unassessed' THEN ${promptMembershipExpression} ELSE 0 END), 0) AS BIGINT) AS summaryPromptRows
        FROM ${table}
        WHERE ${currentProjectWhereClause}
      `,
    )
    const consumerCountSpecs = [
      {
        key: 'routeRows',
        label: 'foreground unassessed route rows',
        note: "Rows matching queue_kind='unassessed' used by foreground queue ordering/filter decisions.",
      },
      {
        key: 'judgmentJobPromptRows',
        label: 'judgment-job prompt rows',
        note: "Rows matching queue_kind='unassessed' with prompt_id present for prompt fanout scheduling.",
      },
      {
        key: 'bulkDistinctArticleRows',
        label: 'bulk distinct article rows',
        note: "Distinct articles matching queue_kind='unassessed' for bulk operation source selection.",
      },
      {
        key: 'summaryPromptRows',
        label: 'summary unassessed prompt rows',
        note: "Rows matching queue_kind='unassessed' with prompt_id present for summary unassessed metrics.",
      },
    ]

    const topProjects = await runReadonlyQuery<{projectId: string; rowCount: number | string}>(
      runtime,
      `
        SELECT project_id AS projectId, CAST(COUNT(*) AS BIGINT) AS rowCount
        FROM ${table}
        GROUP BY project_id
        HAVING COUNT(*) > 0
        ORDER BY COUNT(*) DESC, project_id
        LIMIT ${Math.max(1, limit)}
      `,
    )

    return {
      activeOrLastKnownGoodSnapshotProtectedRows: getNumberOrNull(
        countRows[0]?.activeOrLastKnownGoodSnapshotProtectedRows,
      ),
      candidateRows: getNumberOrNull(countRows[0]?.candidateRows),
      columns,
      consumerCounts: consumerCountSpecs.map((spec) => {
        return {
          currentProjectRows: getNumberOrNull(currentProjectConsumerRows[0]?.[spec.key]),
          globalRows: getNumberOrNull(consumerRows[0]?.[spec.key]),
          label: spec.label,
          note: spec.note,
        }
      }),
      currentProjectRows: getNumberOrNull(countRows[0]?.currentProjectRows),
      distinctArticles: getNumberOrNull(countRows[0]?.distinctArticles),
      distinctPromptPairs: getNumberOrNull(countRows[0]?.distinctPromptPairs),
      duplicateProbes: [
        {
          duplicateCount: await getDuplicateCountForColumns(runtime, table, declaredServingKeyColumns, null),
          keyColumns: declaredServingKeyColumns,
          label: 'declared serving primary/order key',
        },
        {
          duplicateCount: await getDuplicateCountForColumns(runtime, table, orderKeyWithoutQueueIdentityColumns, null),
          keyColumns: orderKeyWithoutQueueIdentityColumns,
          label: 'consumer order key',
        },
      ],
      error: null,
      globalRowCount: getNumberOrNull(countRows[0]?.globalRowCount),
      indexes: await getIndexes(runtime, table),
      missingSnapshotManifestRows: getNumberOrNull(countRows[0]?.missingSnapshotManifestRows),
      note: 'Read-only global/current-project evidence for the unassessed queue serving table. Nonzero active/LKG and candidate rows are protected route/job/summary state; this section does not authorize deletion, slimming, schema changes, migrations, or runtime cleanup.',
      otherRows: getNumberOrNull(countRows[0]?.otherRows),
      pinnedSnapshotRows: getNumberOrNull(countRows[0]?.pinnedSnapshotRows),
      promptNullness: {
        currentProjectNonNullPromptRows: getNumberOrNull(promptRows[0]?.currentProjectNonNullPromptRows),
        currentProjectNullPromptRows: getNumberOrNull(promptRows[0]?.currentProjectNullPromptRows),
        globalNonNullPromptRows: getNumberOrNull(countRows[0]?.globalNonNullPromptRows),
        globalNullPromptRows: getNumberOrNull(countRows[0]?.globalNullPromptRows),
      },
      rowsByProject: topProjects.map((row) => {
        return {label: row.projectId, projectId: row.projectId, rowCount: Number(row.rowCount)}
      }),
      rowsByProtectionAndStatus: rowsByProtectionAndStatus.map((row) => {
        return {
          activeOrLastKnownGoodProtected: Boolean(row.activeOrLastKnownGoodProtected),
          candidateRows: Number(row.candidateRows ?? 0),
          currentProjectRows: Number(row.currentProjectRows ?? 0),
          otherRows: Number(row.otherRows ?? 0),
          pinnedProtected: Boolean(row.pinnedProtected),
          rowCount: Number(row.rowCount ?? 0),
          snapshotStatus: String(row.snapshotStatus ?? 'NULL'),
        }
      }),
      rowsByQueueKind: await getSummaryContributionServingGroupedRows(runtime, table, 'queue_kind', 'queueKind', null),
      table,
      verdict: 'not-authorized',
    }
  } catch (error) {
    return {
      activeOrLastKnownGoodSnapshotProtectedRows: null,
      candidateRows: null,
      columns: [],
      consumerCounts: [],
      currentProjectRows: null,
      distinctArticles: null,
      distinctPromptPairs: null,
      duplicateProbes: [],
      error: error instanceof Error ? error.message : String(error),
      globalRowCount: null,
      indexes: [],
      missingSnapshotManifestRows: null,
      note: 'Read-only unassessed queue evidence collection failed. Failed evidence collection is not deletion/slimming authorization.',
      otherRows: null,
      pinnedSnapshotRows: null,
      promptNullness: {
        currentProjectNonNullPromptRows: null,
        currentProjectNullPromptRows: null,
        globalNonNullPromptRows: null,
        globalNullPromptRows: null,
      },
      rowsByProject: [],
      rowsByProtectionAndStatus: [],
      rowsByQueueKind: [],
      table,
      verdict: 'blocked',
    }
  }
}

const getChunkManifestDiagnosticsReadinessReport = async (
  runtime: QueryRuntime,
  projectId: string,
  limit: number,
): Promise<ChunkManifestDiagnosticsReadinessReport> => {
  const table = 'app.review_rebuild_chunk_manifest' as const
  const projectPredicate = `project_id = ${getSqlLiteral(projectId)}`

  try {
    const totals = await runReadonlyQuery<{
      budgetJsonNonNullRows: number | string
      budgetJsonNullRows: number | string
      currentProjectRows: number | string
      diagnosticsJsonNonNullRows: number | string
      diagnosticsJsonNullRows: number | string
      timingDiagnosticsRows: number | string
    }>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) AS BIGINT) AS currentProjectRows,
          CAST(COUNT(*) FILTER (WHERE budget_json IS NULL) AS BIGINT) AS budgetJsonNullRows,
          CAST(COUNT(*) FILTER (WHERE budget_json IS NOT NULL) AS BIGINT) AS budgetJsonNonNullRows,
          CAST(COUNT(*) FILTER (WHERE diagnostics_json IS NULL) AS BIGINT) AS diagnosticsJsonNullRows,
          CAST(COUNT(*) FILTER (WHERE diagnostics_json IS NOT NULL) AS BIGINT) AS diagnosticsJsonNonNullRows,
          CAST(COUNT(*) FILTER (
            WHERE TRY_CAST(json_extract_string(diagnostics_json, '$.phaseTimings.writeOutputMs') AS DOUBLE) IS NOT NULL
              OR TRY_CAST(json_extract_string(diagnostics_json, '$.phaseTimings.validationMs') AS DOUBLE) IS NOT NULL
          ) AS BIGINT) AS timingDiagnosticsRows
        FROM ${table}
        WHERE ${projectPredicate}
      `,
    )
    const rowsByLifecycle = await runReadonlyQuery<{
      admissionState: string | null
      budgetJsonNonNullRows: number | string
      budgetJsonNullRows: number | string
      diagnosticsJsonNonNullRows: number | string
      diagnosticsJsonNullRows: number | string
      rows: number | string
      status: string | null
      timingDiagnosticsRows: number | string
    }>(
      runtime,
      `
        SELECT
          COALESCE(status, 'NULL') AS status,
          COALESCE(admission_state, 'NULL') AS admissionState,
          CAST(COUNT(*) AS BIGINT) AS rows,
          CAST(COUNT(*) FILTER (WHERE budget_json IS NULL) AS BIGINT) AS budgetJsonNullRows,
          CAST(COUNT(*) FILTER (WHERE budget_json IS NOT NULL) AS BIGINT) AS budgetJsonNonNullRows,
          CAST(COUNT(*) FILTER (WHERE diagnostics_json IS NULL) AS BIGINT) AS diagnosticsJsonNullRows,
          CAST(COUNT(*) FILTER (WHERE diagnostics_json IS NOT NULL) AS BIGINT) AS diagnosticsJsonNonNullRows,
          CAST(COUNT(*) FILTER (
            WHERE TRY_CAST(json_extract_string(diagnostics_json, '$.phaseTimings.writeOutputMs') AS DOUBLE) IS NOT NULL
              OR TRY_CAST(json_extract_string(diagnostics_json, '$.phaseTimings.validationMs') AS DOUBLE) IS NOT NULL
          ) AS BIGINT) AS timingDiagnosticsRows
        FROM ${table}
        WHERE ${projectPredicate}
        GROUP BY status, admission_state
        HAVING COUNT(*) > 0
        ORDER BY COUNT(*) DESC, status, admission_state
        LIMIT ${Math.max(1, limit)}
      `,
    )
    const rowsByProjectionComponent = await runReadonlyQuery<{
      budgetJsonNonNullRows: number | string
      diagnosticsJsonNonNullRows: number | string
      projectionComponent: string | null
      rows: number | string
      timingDiagnosticsRows: number | string
    }>(
      runtime,
      `
        SELECT
          COALESCE(projection_component, 'NULL') AS projectionComponent,
          CAST(COUNT(*) AS BIGINT) AS rows,
          CAST(COUNT(*) FILTER (WHERE budget_json IS NOT NULL) AS BIGINT) AS budgetJsonNonNullRows,
          CAST(COUNT(*) FILTER (WHERE diagnostics_json IS NOT NULL) AS BIGINT) AS diagnosticsJsonNonNullRows,
          CAST(COUNT(*) FILTER (
            WHERE TRY_CAST(json_extract_string(diagnostics_json, '$.phaseTimings.writeOutputMs') AS DOUBLE) IS NOT NULL
              OR TRY_CAST(json_extract_string(diagnostics_json, '$.phaseTimings.validationMs') AS DOUBLE) IS NOT NULL
          ) AS BIGINT) AS timingDiagnosticsRows
        FROM ${table}
        WHERE ${projectPredicate}
        GROUP BY projection_component
        HAVING COUNT(*) > 0
        ORDER BY COUNT(*) DESC, projection_component
        LIMIT ${Math.max(1, limit)}
      `,
    )
    const row = totals[0]

    return {
      budgetJsonNonNullRows: getNumberOrNull(row?.budgetJsonNonNullRows),
      budgetJsonNullRows: getNumberOrNull(row?.budgetJsonNullRows),
      currentProjectRows: getNumberOrNull(row?.currentProjectRows),
      diagnosticsJsonNonNullRows: getNumberOrNull(row?.diagnosticsJsonNonNullRows),
      diagnosticsJsonNullRows: getNumberOrNull(row?.diagnosticsJsonNullRows),
      error: null,
      note: 'Read-only current-project evidence for rebuild chunk manifest JSON diagnostics. budget_json and diagnostics_json feed retry, lifecycle, timing, and operator diagnostics; non-null rows are not field-slimming authorization.',
      rowsByLifecycle: rowsByLifecycle.map((lifecycleRow) => {
        return {
          admissionState: String(lifecycleRow.admissionState ?? 'NULL'),
          budgetJsonNonNullRows: Number(lifecycleRow.budgetJsonNonNullRows ?? 0),
          budgetJsonNullRows: Number(lifecycleRow.budgetJsonNullRows ?? 0),
          diagnosticsJsonNonNullRows: Number(lifecycleRow.diagnosticsJsonNonNullRows ?? 0),
          diagnosticsJsonNullRows: Number(lifecycleRow.diagnosticsJsonNullRows ?? 0),
          rows: Number(lifecycleRow.rows ?? 0),
          status: String(lifecycleRow.status ?? 'NULL'),
          timingDiagnosticsRows: Number(lifecycleRow.timingDiagnosticsRows ?? 0),
        }
      }),
      rowsByProjectionComponent: rowsByProjectionComponent.map((componentRow) => {
        return {
          budgetJsonNonNullRows: Number(componentRow.budgetJsonNonNullRows ?? 0),
          diagnosticsJsonNonNullRows: Number(componentRow.diagnosticsJsonNonNullRows ?? 0),
          projectionComponent: String(componentRow.projectionComponent ?? 'NULL'),
          rows: Number(componentRow.rows ?? 0),
          timingDiagnosticsRows: Number(componentRow.timingDiagnosticsRows ?? 0),
        }
      }),
      table,
      timingDiagnosticsRows: getNumberOrNull(row?.timingDiagnosticsRows),
      verdict: 'not-authorized',
    }
  } catch (error) {
    return {
      budgetJsonNonNullRows: null,
      budgetJsonNullRows: null,
      currentProjectRows: null,
      diagnosticsJsonNonNullRows: null,
      diagnosticsJsonNullRows: null,
      error: error instanceof Error ? error.message : String(error),
      note: 'Read-only rebuild chunk diagnostics evidence collection failed. Failed evidence collection is not field-slimming authorization.',
      rowsByLifecycle: [],
      rowsByProjectionComponent: [],
      table,
      timingDiagnosticsRows: null,
      verdict: 'blocked',
    }
  }
}

const getJudgmentDetailPayloadReadinessReport = async (
  runtime: QueryRuntime,
  projectId: string,
  limit: number,
): Promise<JudgmentDetailPayloadReadinessReport> => {
  const table = 'mart.review_article_judgment_detail_serving_v4' as const

  try {
    const columns = await getTableColumns(runtime, table)
    const hasListModeKey = hasColumn(columns, 'list_mode_key')
    const totals = await runReadonlyQuery<{
      answeredArrayNonNullRows: number | string
      answeredOriginalNonNullRows: number | string
      currentProjectRows: number | string
      globalRowCount: number | string
      detailScalarNonNullRows: number | string
      detailScalarNullRows: number | string
    }>(
      runtime,
      `
        SELECT
          CAST(COUNT(*) AS BIGINT) AS globalRowCount,
          CAST(COUNT(*) FILTER (WHERE project_id = ${getSqlLiteral(projectId)}) AS BIGINT) AS currentProjectRows,
          CAST(COUNT(*) FILTER (WHERE judgment_id IS NULL AND detail_updated_at IS NULL) AS BIGINT) AS detailScalarNullRows,
          CAST(COUNT(*) FILTER (WHERE judgment_id IS NOT NULL OR detail_updated_at IS NOT NULL) AS BIGINT) AS detailScalarNonNullRows,
          CAST(COUNT(*) FILTER (WHERE answered_original IS NOT NULL) AS BIGINT) AS answeredOriginalNonNullRows,
          CAST(COUNT(*) FILTER (WHERE answered_original_as_array IS NOT NULL) AS BIGINT) AS answeredArrayNonNullRows
        FROM ${table}
      `,
    )
    const rowsByPayloadKind = await runReadonlyQuery<{
      answeredArrayNonNullRows: number | string
      answeredOriginalNonNullRows: number | string
      judgmentIdNonNullRows: number | string
      detailScalarNonNullRows: number | string
      payloadModelIdNonNullRows: number | string
      payloadKind: string | null
      placeholderRows: number | string
      rows: number | string
    }>(
      runtime,
      `
        SELECT
          COALESCE(payload_kind, 'NULL') AS payloadKind,
          CAST(COUNT(*) AS BIGINT) AS rows,
          CAST(COUNT(*) FILTER (WHERE judgment_id IS NOT NULL OR detail_updated_at IS NOT NULL) AS BIGINT) AS detailScalarNonNullRows,
          CAST(COUNT(*) FILTER (WHERE judgment_id IS NOT NULL) AS BIGINT) AS judgmentIdNonNullRows,
          CAST(COUNT(*) FILTER (WHERE placeholder_kind IS NOT NULL) AS BIGINT) AS placeholderRows,
          CAST(0 AS BIGINT) AS payloadModelIdNonNullRows,
          CAST(COUNT(*) FILTER (WHERE answered_original IS NOT NULL) AS BIGINT) AS answeredOriginalNonNullRows,
          CAST(COUNT(*) FILTER (WHERE answered_original_as_array IS NOT NULL) AS BIGINT) AS answeredArrayNonNullRows
        FROM ${table}
        GROUP BY payload_kind
        HAVING COUNT(*) > 0
        ORDER BY COUNT(*) DESC, payload_kind
        LIMIT ${Math.max(1, limit)}
      `,
    )
    const sourceJudgmentRows = await runReadonlyQuery<{currentProjectSourceJudgmentRows: number | string}>(
      runtime,
      `
        WITH project_scope_article AS (
          SELECT DISTINCT air.article_id
          FROM app.project_import_route project_route
          INNER JOIN app.article_import_route air
            ON air.import_route_id = project_route.import_route_id
          WHERE project_route.project_id = ${getSqlLiteral(projectId)}
          UNION
          SELECT DISTINCT project_article.article_id
          FROM app.project_article project_article
          WHERE project_article.project_id = ${getSqlLiteral(projectId)}
        )
        SELECT
          CAST(COUNT(*) AS BIGINT) AS currentProjectSourceJudgmentRows
        FROM app."judgment" judgment
        INNER JOIN project_scope_article
          ON project_scope_article.article_id = judgment.article_id
        WHERE judgment.deleted_at IS NULL
      `,
    )
    const rowsByListMode = hasListModeKey
      ? await runReadonlyQuery<{
          detailScalarNonNullRows: number | string
          listModeKey: string | null
          rows: number | string
        }>(
          runtime,
          `
            SELECT
              COALESCE(list_mode_key, 'NULL') AS listModeKey,
              CAST(COUNT(*) AS BIGINT) AS rows,
              CAST(COUNT(*) FILTER (WHERE judgment_id IS NOT NULL OR detail_updated_at IS NOT NULL) AS BIGINT) AS detailScalarNonNullRows
            FROM ${table}
            GROUP BY list_mode_key
            HAVING COUNT(*) > 0
            ORDER BY COUNT(*) DESC, list_mode_key
            LIMIT ${Math.max(1, limit)}
          `,
        )
      : []
    const row = totals[0]

    return {
      answeredArrayNonNullRows: getNumberOrNull(row?.answeredArrayNonNullRows),
      answeredOriginalNonNullRows: getNumberOrNull(row?.answeredOriginalNonNullRows),
      currentProjectRows: getNumberOrNull(row?.currentProjectRows),
      error: null,
      globalRowCount: getNumberOrNull(row?.globalRowCount),
      judgmentPayloadNonNullRows: getNumberOrNull(row?.detailScalarNonNullRows),
      judgmentPayloadNullRows: getNumberOrNull(row?.detailScalarNullRows),
      note: 'Read-only global/current-project evidence for judgment detail scalar storage. This section tracks the post-JSON detail hydration shape and does not authorize answer-column slimming.',
      rowsByListMode: rowsByListMode.map((listModeRow) => {
        return {
          judgmentPayloadNonNullRows: Number(listModeRow.detailScalarNonNullRows ?? 0),
          listModeKey: String(listModeRow.listModeKey ?? 'NULL'),
          rows: Number(listModeRow.rows ?? 0),
        }
      }),
      rowsByPayloadKind: rowsByPayloadKind.map((payloadKindRow) => {
        return {
          answeredArrayNonNullRows: Number(payloadKindRow.answeredArrayNonNullRows ?? 0),
          answeredOriginalNonNullRows: Number(payloadKindRow.answeredOriginalNonNullRows ?? 0),
          judgmentIdNonNullRows: Number(payloadKindRow.judgmentIdNonNullRows ?? 0),
          judgmentPayloadNonNullRows: Number(payloadKindRow.detailScalarNonNullRows ?? 0),
          payloadModelIdNonNullRows: Number(payloadKindRow.payloadModelIdNonNullRows ?? 0),
          payloadKind: String(payloadKindRow.payloadKind ?? 'NULL'),
          placeholderRows: Number(payloadKindRow.placeholderRows ?? 0),
          rows: Number(payloadKindRow.rows ?? 0),
        }
      }),
      rowsByPayloadTopLevelKey: [],
      sourceJudgmentEvidence: {
        currentProjectSourceJudgmentRows: getNumberOrNull(sourceJudgmentRows[0]?.currentProjectSourceJudgmentRows),
        note: 'Current-project source judgment row count is context for payload scalarization only. The old serving mart model identifier column has already been dropped, so this probe intentionally avoids stale model readiness checks.',
      },
      table,
      verdict: 'not-authorized',
    }
  } catch (error) {
    return {
      answeredArrayNonNullRows: null,
      answeredOriginalNonNullRows: null,
      currentProjectRows: null,
      error: error instanceof Error ? error.message : String(error),
      globalRowCount: null,
      judgmentPayloadNonNullRows: null,
      judgmentPayloadNullRows: null,
      note: 'Read-only judgment detail payload evidence collection failed. Failed evidence collection is not field-slimming authorization.',
      rowsByListMode: [],
      rowsByPayloadKind: [],
      rowsByPayloadTopLevelKey: [],
      sourceJudgmentEvidence: {
        currentProjectSourceJudgmentRows: null,
        note: 'Not collected because judgment detail payload readiness collection failed.',
      },
      table,
      verdict: 'blocked',
    }
  }
}

const getTableEvidence = async (runtime: QueryRuntime, table: string, options: CliOptions): Promise<TableEvidence> => {
  try {
    const columns = await getTableColumns(runtime, table)
    const whereClause = getWhereClause(columns, options.projectId)
    const columnProfiles: ColumnProfile[] = []

    for (const column of getProfileColumns(columns, options.maxProfileColumns)) {
      columnProfiles.push(await getColumnProfile(runtime, table, column, whereClause))
    }

    return {
      columnCount: columns.length,
      columnProfiles,
      duplicateProbe: await getDuplicateProbe(runtime, table, columns, whereClause),
      error: null,
      indexes: await getIndexes(runtime, table),
      oldestNewest: await getOldestNewest(runtime, table, columns, whereClause),
      rowCount: await getRowCount(runtime, table, whereClause),
      sizeProxies: await getSizeProxies(runtime, table, columns, whereClause),
      table,
      whereClause,
    }
  } catch (error) {
    return {
      columnCount: 0,
      columnProfiles: [],
      duplicateProbe: {duplicateCount: null, keyColumns: [], sql: null},
      error: error instanceof Error ? error.message : String(error),
      indexes: [],
      oldestNewest: {},
      rowCount: null,
      sizeProxies: {},
      table,
      whereClause: null,
    }
  }
}

const formatMarkdownTable = (headers: string[], rows: string[][]) => {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers
      .map(() => {
        return '---'
      })
      .join(' | ')} |`,
    ...rows.map((row) => {
      return `| ${row.join(' | ')} |`
    }),
  ].join('\n')
}

const formatValue = (value: unknown) => {
  if (value === null || value === undefined) {
    return ''
  }

  const stringValue =
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
      ? `${value}`
      : JSON.stringify(value)

  return (stringValue ?? '').replaceAll('\n', ' ').replaceAll('|', '\\|')
}

const renderMarkdown = (report: EvidenceReport) => {
  const summaryRows = report.tables.map((table) => {
    return [
      `\`${table.table}\``,
      formatValue(table.rowCount),
      formatValue(table.columnCount),
      table.whereClause ? `\`${table.whereClause}\`` : 'global',
      formatValue(table.indexes.length),
      formatValue(table.duplicateProbe.duplicateCount),
      table.error ? `Blocked: ${table.error}` : 'ok',
    ]
  })
  const retentionCleanupEligibilityRows = report.retentionCleanupEligibility.tables.map((table) => {
    return [
      `\`${table.table}\``,
      formatValue(table.totalScopedRows),
      formatValue(table.activeOrLastKnownGoodSnapshotProtectedRows),
      formatValue(table.pinnedSnapshotProtectedRows),
      formatValue(table.completedRequestAndSummaryChunkCandidateRows),
      formatValue(table.protectedRebuildRequestRows),
      formatValue(table.newestDiagnosticRequestProtectedRows),
      formatValue(table.dependentPartialBlockedRows),
      formatValue(table.eligibleRows),
      table.error ? `Blocked: ${table.error}` : 'ok',
    ]
  })
  const retentionCleanupBlockerRows = report.retentionCleanupEligibility.tables.flatMap((table) => {
    return table.blockerCounts.map((blocker) => {
      return [`\`${table.table}\``, `\`${blocker.category}\``, formatValue(blocker.rowCount)]
    })
  })
  const dirtyWorkLifecycleRows = [
    ['Total', formatValue(report.dirtyWorkRetentionEvidence.lifecycleCounts.total)],
    ['Pending', formatValue(report.dirtyWorkRetentionEvidence.lifecycleCounts.pending)],
    ['Running', formatValue(report.dirtyWorkRetentionEvidence.lifecycleCounts.running)],
    ['Failed', formatValue(report.dirtyWorkRetentionEvidence.lifecycleCounts.failed)],
    ['Completed', formatValue(report.dirtyWorkRetentionEvidence.lifecycleCounts.completed)],
    ['Protected non-completed rows', formatValue(report.dirtyWorkRetentionEvidence.protectedNonCompletedRows)],
    [
      'Completed rows covered by ACK + project/source watermark',
      formatValue(report.dirtyWorkRetentionEvidence.completedRowsCoveredByAckAndProjectWatermark),
    ],
  ]
  const dirtyWorkAckRows = report.dirtyWorkRetentionEvidence.ackCounts.map((row) => {
    return [`\`${row.ackKind}\``, formatValue(row.rows)]
  })
  const dirtyWorkLaneRows = report.dirtyWorkRetentionEvidence.laneCounts.map((row) => {
    return [
      `\`${row.projectId}\``,
      `\`${row.projectionComponent}\``,
      `\`${row.projectionIdentity}\``,
      `\`${row.dirtyKind}\``,
      `\`${row.sourcePartition}\``,
      `\`${row.status}\``,
      formatValue(row.rows),
    ]
  })
  const dirtyWorkBlockerRows = report.dirtyWorkRetentionEvidence.blockerCounts.map((row) => {
    return [`\`${row.category}\``, formatValue(row.rows)]
  })
  const filteredCountSnapshotListModeRows =
    report.filteredCountServingPhysicalEvidence.rowsBySnapshotStatusAndListMode.map((row) => {
      return [
        `\`${row.snapshotStatus}\``,
        `\`${row.listModeKey}\``,
        formatValue(row.rowCount),
        formatValue(row.currentProjectRows),
      ]
    })
  const filteredCountTtlRows = report.filteredCountServingPhysicalEvidence.staleByTtlCandidateCounts.map((row) => {
    return [`\`${row.bucket}\``, formatValue(row.candidateRows), formatValue(row.currentProjectCandidateRows)]
  })
  const rebuildRequestlessArtifactDispositionRows =
    report.rebuildArtifactDispositionEvidence.requestlessRowsByAdoptionHint.map((row) => {
      return [
        `\`${row.adoptionHint}\``,
        formatValue(row.rows),
        formatValue(row.distinctChunks),
        formatValue(row.summaryRows),
        formatValue(row.partialDependencyRows),
      ]
    })
  const rebuildArtifactDispositionRows = report.rebuildArtifactDispositionEvidence.artifactRowsByRequestDisposition.map(
    (row) => {
      return [
        `\`${row.artifactTable}\``,
        `\`${row.requestDisposition}\``,
        formatValue(row.rows),
        formatValue(row.distinctRequests),
        formatValue(row.distinctChunks),
      ]
    },
  )
  const rebuildRequestDispositionRows = report.rebuildArtifactDispositionEvidence.requestRowsByDisposition.map(
    (row) => {
      return [
        `\`${row.requestDisposition}\``,
        formatValue(row.requests),
        formatValue(row.chunkRows),
        row.sampleRequestIds
          .map((requestId) => {
            return `\`${requestId}\``
          })
          .join(', '),
      ]
    },
  )
  const summaryRebuildAccumulatorLifecycleRows =
    report.summaryRebuildAccumulatorLifecycleEvidence.rowsByRequestLifecycle.map((row) => {
      return [
        `\`${row.requestDisposition}\``,
        `\`${row.requestStatus}\``,
        `\`${row.admissionState}\``,
        formatValue(row.rows),
        formatValue(row.distinctRequests),
      ]
    })
  const summaryRebuildAccumulatorBlockerRows = report.summaryRebuildAccumulatorLifecycleEvidence.blockerCounts.map(
    (row) => {
      return [`\`${row.category}\``, formatValue(row.rows)]
    },
  )
  const rebuildRequestLifecycleColumnRows = report.rebuildRequestLifecycleFieldEvidence.columns.map((column) => {
    return [
      `\`${column.column}\``,
      formatValue(column.globalNullCount),
      formatValue(column.globalNonNullCount),
      formatValue(column.currentProjectNullCount),
      formatValue(column.currentProjectNonNullCount),
    ]
  })
  const rebuildRequestLifecycleReasonRows = report.rebuildRequestLifecycleFieldEvidence.rowsByReasonAndStatus.map(
    (row) => {
      return [
        `\`${row.reason}\``,
        `\`${row.status}\``,
        `\`${row.admissionState}\``,
        formatValue(row.rows),
        formatValue(row.nonNullLifecycleFieldRows),
      ]
    },
  )
  const selectedImportPayloadRows = report.selectedImportPayloadSlimmingReadiness.columns.map((column) => {
    return [
      `\`${column.column}\``,
      column.selectedBaseColumnStatus,
      formatValue(column.selectedBaseNullCount),
      formatValue(column.selectedBaseNonNullCount),
      formatValue(column.selectedBaseActiveOrLastKnownGoodNullCount),
      formatValue(column.selectedBaseActiveOrLastKnownGoodNonNullCount),
      formatValue(column.selectedBaseCandidateNullCount),
      formatValue(column.selectedBaseCandidateNonNullCount),
      formatValue(column.selectedBaseOtherNullCount),
      formatValue(column.selectedBaseOtherNonNullCount),
      formatValue(column.hotFieldNullCount),
      formatValue(column.hotFieldNonNullCount),
    ]
  })
  const selectedImportSnapshotStatusRows =
    report.selectedImportPayloadSlimmingReadiness.rowsBySelectedImportSnapshotStatus.map((row) => {
      return [`\`${row.label}\``, formatValue(row.rowCount)]
    })
  const selectedImportDisplayCopyGlobalColumnRows =
    report.selectedImportPayloadSlimmingReadiness.selectedImportDisplayCopyGlobalEvidence.columns.map((column) => {
      return [`\`${column.column}\``, column.status, formatValue(column.nullCount), formatValue(column.nonNullCount)]
    })
  const selectedImportDisplayCopyGlobalStatusRows =
    report.selectedImportPayloadSlimmingReadiness.selectedImportDisplayCopyGlobalEvidence.rows.map((row) => {
      return [
        `\`${row.snapshotStatus}\``,
        row.activeOrLastKnownGoodProtected ? 'yes' : 'no',
        formatValue(row.rowCount),
        formatValue(row.activeOrLastKnownGoodProtected ? row.rowCount : 0),
        formatValue(row.candidateRows),
        formatValue(row.otherRows),
        ...selectedImportDisplayCopyColumns.flatMap((column) => {
          return [formatValue(row.nullCounts[column]), formatValue(row.nonNullCounts[column])]
        }),
      ]
    })
  const selectedImportDuplicateConflictStatusRows =
    report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.rows.map((row) => {
      return [
        `\`${row.snapshotStatus}\``,
        row.activeOrLastKnownGoodProtected ? 'yes' : 'no',
        formatValue(row.rowCount),
        formatValue(row.activeOrLastKnownGoodProtected ? row.rowCount : 0),
        formatValue(row.candidateRows),
        formatValue(row.otherRows),
        formatValue(row.hotResolvedRows),
        formatValue(row.missingHotRows),
        formatValue(row.selectedBaseDuplicateTrueRows),
        formatValue(row.hotDuplicateTrueRows),
        formatValue(row.duplicateMismatchRows),
        formatValue(row.selectedBaseFalseOrDefaultDuplicateRowsWithoutHot),
        formatValue(row.selectedBaseTrueDuplicateRowsWithoutHot),
        formatValue(row.selectedBaseConflictTrueRows),
        formatValue(row.hotConflictTrueRows),
        formatValue(row.conflictMismatchRows),
        formatValue(row.selectedBaseFalseOrDefaultConflictRowsWithoutHot),
        formatValue(row.selectedBaseTrueConflictRowsWithoutHot),
      ]
    })
  const selectedImportStagingPublishStateRows = report.selectedImportStagingPhysicalEvidence.rowsByPublishState.map(
    (row) => {
      return [`\`${row.publishState}\``, formatValue(row.rowCount), formatValue(row.currentProjectRows)]
    },
  )
  const selectedImportStagingSourcePartitionRows =
    report.selectedImportStagingPhysicalEvidence.rowsBySourcePartition.map((row) => {
      return [
        `\`${row.sourcePartition}\``,
        formatValue(row.rowCount),
        formatValue(row.currentProjectRows),
        formatValue(row.publishedRows),
        formatValue(row.unpublishedRows),
      ]
    })
  const selectedImportStagingDuplicateRows = report.selectedImportStagingPhysicalEvidence.duplicateProbes.map(
    (probe) => {
      return [
        probe.label,
        probe.keyColumns
          .map((column) => {
            return `\`${column}\``
          })
          .join(', '),
        formatValue(probe.duplicateCount),
        probe.sampleRows.length > 0 ? formatValue(JSON.stringify(probe.sampleRows)) : 'none',
      ]
    },
  )
  const projectorWatermarkNullableColumnRows = report.projectorWatermarkNullableFieldEvidence.columns.map((column) => {
    return [
      `\`${column.column}\``,
      formatValue(column.globalNullCount),
      formatValue(column.globalNonNullCount),
      formatValue(column.currentProjectNullCount),
      formatValue(column.currentProjectNonNullCount),
    ]
  })
  const projectorWatermarkProjectScopeRows = report.projectorWatermarkNullableFieldEvidence.rowsByProjectScope.map(
    (row) => {
      return [`\`${row.label}\``, formatValue(row.rowCount)]
    },
  )
  const projectorWatermarkSourcePartitionRows =
    report.projectorWatermarkNullableFieldEvidence.rowsBySourcePartition.map((row) => {
      return [`\`${row.label}\``, formatValue(row.rowCount)]
    })
  const hotPayloadArrayProxyRows = report.hotPayloadProxyEvidence.arrayColumns.map((proxy) => {
    return [
      `\`${proxy.table}\``,
      `\`${proxy.column}\``,
      formatValue(proxy.rowCount),
      formatValue(proxy.currentProjectRows),
      formatValue(proxy.totalArrayMemberships),
      formatValue(proxy.maxArrayLength),
      formatValue(proxy.avgArrayLength),
      formatValue(proxy.approxStringBytes),
      proxy.error ? `Blocked: ${proxy.error}` : proxy.status,
    ]
  })
  const hotPayloadScalarProxyRows = report.hotPayloadProxyEvidence.scalarColumns.map((proxy) => {
    return [
      `\`${proxy.table}\``,
      `\`${proxy.column}\``,
      formatValue(proxy.rowCount),
      formatValue(proxy.currentProjectRows),
      formatValue(proxy.nonNullRows),
      formatValue(proxy.approxStringBytes),
      proxy.error ? `Blocked: ${proxy.error}` : proxy.status,
    ]
  })
  const summaryContributionDuplicateRows = report.summaryContributionServingReadiness.duplicateProbes.map((probe) => {
    return [
      probe.label,
      probe.keyColumns
        .map((column) => {
          return `\`${column}\``
        })
        .join(', '),
      formatValue(probe.duplicateCount),
    ]
  })
  const summaryContributionColumnRows = report.summaryContributionServingReadiness.columns.map((column) => {
    return [`\`${column.column_name}\``, `\`${column.data_type}\``]
  })
  const summaryContributionTopProjectRows = report.summaryContributionServingReadiness.topProjects.map((project) => {
    return [`\`${project.projectId}\``, formatValue(project.rowCount)]
  })
  const summaryContributionProjectRows = report.summaryContributionServingReadiness.rowsByProject.map((project) => {
    return [`\`${project.projectId}\``, formatValue(project.rowCount)]
  })
  const summaryContributionComponentKindRows = report.summaryContributionServingReadiness.rowsByComponentKind.map(
    (row) => {
      return [`\`${row.label}\``, formatValue(row.rowCount)]
    },
  )
  const summaryContributionDefinitionVersionRows =
    report.summaryContributionServingReadiness.rowsBySummaryDefinitionVersion.map((row) => {
      return [`\`${row.label}\``, formatValue(row.rowCount)]
    })
  const summaryContributionContributionKeyRows = report.summaryContributionServingReadiness.topContributionKeys.map(
    (row) => {
      return [`\`${row.label}\``, formatValue(row.rowCount)]
    },
  )
  const summaryContributionSnapshotStatusRows = report.summaryContributionServingReadiness.rowsBySnapshotStatus.map(
    (row) => {
      return [`\`${row.label}\``, formatValue(row.rowCount)]
    },
  )
  const summaryContributionRecoverabilityRows =
    report.summaryContributionServingReadiness.recoverabilityComparisons.map((comparison) => {
      return [
        comparison.summaryKind,
        formatValue(comparison.contributionGroups),
        formatValue(comparison.finalRows),
        formatValue(comparison.matchedFinalRows),
        formatValue(comparison.missingFinalRows),
        formatValue(comparison.mismatchedFinalRows),
        formatValue(comparison.finalRowsMissingContributionGroup),
        comparison.error ? `Blocked: ${comparison.error}` : 'ok',
      ]
    })
  const unassessedQueueProtectionStatusRows = report.unassessedQueueServingReadiness.rowsByProtectionAndStatus.map(
    (row) => {
      return [
        `\`${row.snapshotStatus}\``,
        row.activeOrLastKnownGoodProtected ? 'yes' : 'no',
        row.pinnedProtected ? 'yes' : 'no',
        formatValue(row.rowCount),
        formatValue(row.currentProjectRows),
        formatValue(row.candidateRows),
        formatValue(row.otherRows),
      ]
    },
  )
  const unassessedQueueKindRows = report.unassessedQueueServingReadiness.rowsByQueueKind.map((row) => {
    return [`\`${row.label}\``, formatValue(row.rowCount)]
  })
  const unassessedQueueProjectRows = report.unassessedQueueServingReadiness.rowsByProject.map((project) => {
    return [`\`${project.projectId}\``, formatValue(project.rowCount)]
  })
  const unassessedQueueDuplicateRows = report.unassessedQueueServingReadiness.duplicateProbes.map((probe) => {
    return [
      probe.label,
      probe.keyColumns
        .map((column) => {
          return `\`${column}\``
        })
        .join(', '),
      formatValue(probe.duplicateCount),
    ]
  })
  const unassessedQueueConsumerRows = report.unassessedQueueServingReadiness.consumerCounts.map((consumer) => {
    return [consumer.label, formatValue(consumer.globalRows), formatValue(consumer.currentProjectRows), consumer.note]
  })
  const unassessedQueueColumnRows = report.unassessedQueueServingReadiness.columns.map((column) => {
    return [`\`${column.column_name}\``, `\`${column.data_type}\``]
  })
  const unassessedQueueIndexRows = report.unassessedQueueServingReadiness.indexes.map((index) => {
    return [formatValue(JSON.stringify(index))]
  })
  const chunkDiagnosticsLifecycleRows = report.chunkManifestDiagnosticsReadiness.rowsByLifecycle.map((row) => {
    return [
      `\`${row.status}\``,
      `\`${row.admissionState}\``,
      formatValue(row.rows),
      formatValue(row.budgetJsonNullRows),
      formatValue(row.budgetJsonNonNullRows),
      formatValue(row.diagnosticsJsonNullRows),
      formatValue(row.diagnosticsJsonNonNullRows),
      formatValue(row.timingDiagnosticsRows),
    ]
  })
  const chunkDiagnosticsProjectionRows = report.chunkManifestDiagnosticsReadiness.rowsByProjectionComponent.map(
    (row) => {
      return [
        `\`${row.projectionComponent}\``,
        formatValue(row.rows),
        formatValue(row.budgetJsonNonNullRows),
        formatValue(row.diagnosticsJsonNonNullRows),
        formatValue(row.timingDiagnosticsRows),
      ]
    },
  )
  const judgmentDetailPayloadKindRows = report.judgmentDetailPayloadReadiness.rowsByPayloadKind.map((row) => {
    return [
      `\`${row.payloadKind}\``,
      formatValue(row.rows),
      formatValue(row.judgmentPayloadNonNullRows),
      formatValue(row.judgmentIdNonNullRows),
      formatValue(row.placeholderRows),
      formatValue(row.payloadModelIdNonNullRows),
      formatValue(row.answeredOriginalNonNullRows),
      formatValue(row.answeredArrayNonNullRows),
    ]
  })
  const judgmentDetailListModeRows = report.judgmentDetailPayloadReadiness.rowsByListMode.map((row) => {
    return [`\`${row.listModeKey}\``, formatValue(row.rows), formatValue(row.judgmentPayloadNonNullRows)]
  })
  const judgmentDetailPayloadTopLevelKeyRows = report.judgmentDetailPayloadReadiness.rowsByPayloadTopLevelKey.map(
    (row) => {
      return [
        `\`${row.payloadKind}\``,
        `\`${row.key}\``,
        formatValue(row.globalRows),
        formatValue(row.currentProjectRows),
      ]
    },
  )
  const summaryContributionIndexRows = report.summaryContributionServingReadiness.indexes.map((index) => {
    return [formatValue(JSON.stringify(index))]
  })

  const sections = report.tables.map((table) => {
    const timestampRows = Object.entries(table.oldestNewest).map(([column, values]) => {
      return [`\`${column}\``, formatValue(values.min), formatValue(values.max)]
    })
    const profileRows = table.columnProfiles.map((column) => {
      return [
        `\`${column.column}\``,
        `\`${column.type}\``,
        formatValue(column.nullCount),
        formatValue(column.nonNullCount),
        formatValue(column.approxDistinctCount),
      ]
    })
    const sizeRows = Object.entries(table.sizeProxies).map(([key, value]) => {
      return [`\`${key}\``, formatValue(value)]
    })

    return [
      `## ${table.table}`,
      '',
      `- Row count scope: ${table.whereClause ? `\`${table.whereClause}\`` : 'global table count'}`,
      `- Rows: ${formatValue(table.rowCount)}`,
      `- Columns: ${table.columnCount}`,
      `- Indexes observed: ${table.indexes.length}`,
      `- Duplicate key columns: ${
        table.duplicateProbe.keyColumns
          .map((column) => {
            return `\`${column}\``
          })
          .join(', ') || 'not probed'
      }`,
      `- Duplicate key count: ${formatValue(table.duplicateProbe.duplicateCount)}`,
      table.error ? `- Error: ${table.error}` : null,
      '',
      timestampRows.length > 0
        ? formatMarkdownTable(['Timestamp column', 'Oldest', 'Newest'], timestampRows)
        : '_No timestamp columns from the evidence allowlist were present._',
      '',
      profileRows.length > 0
        ? formatMarkdownTable(['Column', 'Type', 'Nulls', 'Non-nulls', 'Approx distinct'], profileRows)
        : '_No column profile rows were collected._',
      '',
      sizeRows.length > 0
        ? formatMarkdownTable(['Size proxy', 'Value'], sizeRows)
        : '_No JSON/payload size proxies collected._',
    ]
      .filter((entry): entry is string => {
        return entry !== null
      })
      .join('\n')
  })

  return [
    '# Review Storage Shape Physical Evidence',
    '',
    `Generated at: ${report.generatedAt}`,
    '',
    `Mode: ${report.mode}`,
    '',
    `Project ID: \`${report.options.projectId}\``,
    '',
    `Snapshot path used during collection: \`${report.snapshotPath}\``,
    '',
    'This file is a physical evidence artifact for the review-serving storage/performance plan. It does not authorize deletion, slimming, or migration work by itself; see `docs/review-serving-storage-performance.md` for the current decision boundary.',
    '',
    '## Table Summary',
    '',
    formatMarkdownTable(['Table', 'Rows', 'Columns', 'Scope', 'Indexes', 'Duplicate keys', 'Status'], summaryRows),
    '',
    '## Retention Cleanup Eligibility',
    '',
    report.retentionCleanupEligibility.note,
    '',
    formatMarkdownTable(
      [
        'Table',
        'Scoped rows',
        'Active/LKG protected',
        'Pinned protected',
        'Completed request+chunk candidates',
        'Protected request',
        'Newest diagnostic',
        'Dependent partial blocker',
        'Eligible',
        'Status',
      ],
      retentionCleanupEligibilityRows,
    ),
    '',
    retentionCleanupBlockerRows.length > 0
      ? formatMarkdownTable(['Table', 'First blocker/category', 'Rows'], retentionCleanupBlockerRows)
      : '_No retention cleanup blocker categories were collected._',
    '',
    '## Filtered-Count Serving Physical Evidence',
    '',
    `Verdict: ${
      report.filteredCountServingPhysicalEvidence.verdict === 'not-authorized'
        ? 'not-authorized (evidence only; not deletion authorization)'
        : 'blocked'
    }`,
    '',
    report.filteredCountServingPhysicalEvidence.note,
    '',
    `Table: \`${report.filteredCountServingPhysicalEvidence.table}\``,
    '',
    `Total rows: ${formatValue(report.filteredCountServingPhysicalEvidence.totalRowCount)}`,
    '',
    `Global rows: ${formatValue(report.filteredCountServingPhysicalEvidence.globalRowCount)}`,
    '',
    `Current-project rows: ${formatValue(report.filteredCountServingPhysicalEvidence.currentProjectRows)}`,
    '',
    `Active/LKG snapshot protected rows: ${formatValue(report.filteredCountServingPhysicalEvidence.activeOrLastKnownGoodSnapshotProtectedRows)}`,
    '',
    `Pinned snapshot protected rows: ${formatValue(report.filteredCountServingPhysicalEvidence.pinnedSnapshotProtectedRows)}`,
    '',
    `Rows with missing snapshot manifest: ${formatValue(report.filteredCountServingPhysicalEvidence.missingSnapshotManifestRows)}`,
    '',
    `Max rows per (project_id, review_config_hash, snapshot_id, list_mode_key): ${formatValue(report.filteredCountServingPhysicalEvidence.groupStats.maxRowsPerProjectConfigSnapshotListMode)}`,
    '',
    `Avg rows per (project_id, review_config_hash, snapshot_id, list_mode_key): ${formatValue(report.filteredCountServingPhysicalEvidence.groupStats.avgRowsPerProjectConfigSnapshotListMode)}`,
    '',
    report.filteredCountServingPhysicalEvidence.error
      ? `Status: Blocked: ${report.filteredCountServingPhysicalEvidence.error}`
      : 'Status: ok',
    '',
    filteredCountSnapshotListModeRows.length > 0
      ? formatMarkdownTable(
          ['Snapshot status', 'List mode', 'Rows', 'Current-project rows'],
          filteredCountSnapshotListModeRows,
        )
      : '_No filtered-count snapshot-status/list-mode rows were collected._',
    '',
    filteredCountTtlRows.length > 0
      ? formatMarkdownTable(['TTL bucket', 'Candidate rows', 'Current-project candidate rows'], filteredCountTtlRows)
      : '_No filtered-count TTL candidate rows were collected._',
    '',
    '## Hot Payload Proxy Evidence',
    '',
    `Verdict: ${
      report.hotPayloadProxyEvidence.verdict === 'not-authorized'
        ? 'not-authorized (proof-only; not deletion/slimming authorization)'
        : 'blocked'
    }`,
    '',
    report.hotPayloadProxyEvidence.note,
    '',
    hotPayloadArrayProxyRows.length > 0
      ? formatMarkdownTable(
          [
            'Table',
            'Array column',
            'Rows',
            'Current-project rows',
            'Total array memberships',
            'Max array length',
            'Avg array length',
            'Approx string bytes',
            'Status',
          ],
          hotPayloadArrayProxyRows,
        )
      : '_No hot array payload proxy evidence rows were collected._',
    '',
    hotPayloadScalarProxyRows.length > 0
      ? formatMarkdownTable(
          ['Table', 'Scalar column', 'Rows', 'Current-project rows', 'Non-null rows', 'Approx string bytes', 'Status'],
          hotPayloadScalarProxyRows,
        )
      : '_No hot scalar payload proxy evidence rows were collected._',
    '',
    '## Dirty-Work Retention Evidence',
    '',
    `Verdict: ${
      report.dirtyWorkRetentionEvidence.verdict === 'not-authorized'
        ? 'not-authorized (not retention cleanup authorization)'
        : 'blocked'
    }`,
    '',
    report.dirtyWorkRetentionEvidence.note,
    '',
    `Dirty-work table: \`${report.dirtyWorkRetentionEvidence.dirtyWorkTable}\``,
    '',
    `ACK table: \`${report.dirtyWorkRetentionEvidence.ackTable}\``,
    '',
    `Project/source watermark table: \`${report.dirtyWorkRetentionEvidence.watermarkTable}\``,
    '',
    report.dirtyWorkRetentionEvidence.error
      ? `Status: Blocked: ${report.dirtyWorkRetentionEvidence.error}`
      : 'Status: ok',
    '',
    formatMarkdownTable(['Lifecycle field', 'Rows'], dirtyWorkLifecycleRows),
    '',
    dirtyWorkAckRows.length > 0
      ? formatMarkdownTable(['ACK kind', 'Rows'], dirtyWorkAckRows)
      : '_No completed dirty-work ACK rows were collected._',
    '',
    dirtyWorkLaneRows.length > 0
      ? formatMarkdownTable(
          [
            'Project',
            'Projection component',
            'Projection identity',
            'Dirty kind',
            'Source partition',
            'Status',
            'Rows',
          ],
          dirtyWorkLaneRows,
        )
      : '_No dirty-work lane rows were collected._',
    '',
    dirtyWorkBlockerRows.length > 0
      ? formatMarkdownTable(['Retention blocker/category', 'Rows'], dirtyWorkBlockerRows)
      : '_No dirty-work retention blocker categories were collected._',
    '',
    '## Rebuild Artifact Disposition Evidence',
    '',
    `Verdict: ${report.rebuildArtifactDispositionEvidence.verdict === 'not-authorized' ? 'not-authorized (not retention cleanup authorization)' : 'blocked'}`,
    '',
    report.rebuildArtifactDispositionEvidence.note,
    '',
    `Table: \`${report.rebuildArtifactDispositionEvidence.table}\``,
    '',
    `Current-project chunk-manifest rows: ${formatValue(report.rebuildArtifactDispositionEvidence.currentProjectChunkRows)}`,
    '',
    `Requestless chunk-manifest rows: ${formatValue(report.rebuildArtifactDispositionEvidence.requestlessChunkRows)}`,
    '',
    report.rebuildArtifactDispositionEvidence.error
      ? `Status: Blocked: ${report.rebuildArtifactDispositionEvidence.error}`
      : 'Status: ok',
    '',
    rebuildRequestlessArtifactDispositionRows.length > 0
      ? formatMarkdownTable(
          ['Adoption hint', 'Rows', 'Distinct chunks', 'Summary rows', 'Partial dependency rows'],
          rebuildRequestlessArtifactDispositionRows,
        )
      : '_No requestless chunk-manifest rows were collected._',
    '',
    rebuildArtifactDispositionRows.length > 0
      ? formatMarkdownTable(
          ['Artifact table', 'Request disposition', 'Rows', 'Distinct requests', 'Distinct chunks'],
          rebuildArtifactDispositionRows,
        )
      : '_No partial/chunk artifact disposition rows were collected._',
    '',
    rebuildRequestDispositionRows.length > 0
      ? formatMarkdownTable(
          ['Request disposition', 'Requests', 'Chunk rows', 'Sample request ids'],
          rebuildRequestDispositionRows,
        )
      : '_No rebuild request disposition rows were collected._',
    '',
    '## Summary Rebuild Accumulator Lifecycle Evidence',
    '',
    `Verdict: ${
      report.summaryRebuildAccumulatorLifecycleEvidence.verdict === 'not-authorized'
        ? 'not-authorized (proof-only; not retention cleanup authorization)'
        : 'blocked'
    }`,
    '',
    report.summaryRebuildAccumulatorLifecycleEvidence.note,
    '',
    `Table: \`${report.summaryRebuildAccumulatorLifecycleEvidence.table}\``,
    '',
    `Global rows: ${formatValue(report.summaryRebuildAccumulatorLifecycleEvidence.globalRows)}`,
    '',
    `Current-project rows: ${formatValue(report.summaryRebuildAccumulatorLifecycleEvidence.currentProjectRows)}`,
    '',
    `Active request rows: ${formatValue(report.summaryRebuildAccumulatorLifecycleEvidence.activeRequestRows)}`,
    '',
    `Admitted request rows: ${formatValue(report.summaryRebuildAccumulatorLifecycleEvidence.admittedRequestRows)}`,
    '',
    `Protected request rows: ${formatValue(report.summaryRebuildAccumulatorLifecycleEvidence.protectedRequestRows)}`,
    '',
    `Newest diagnostic request protected rows: ${formatValue(report.summaryRebuildAccumulatorLifecycleEvidence.newestDiagnosticRequestProtectedRows)}`,
    '',
    `Terminal request candidate rows: ${formatValue(report.summaryRebuildAccumulatorLifecycleEvidence.terminalRequestCandidateRows)}`,
    '',
    `Completed request candidate rows: ${formatValue(report.summaryRebuildAccumulatorLifecycleEvidence.completedRequestCandidateRows)}`,
    '',
    `Failed request candidate rows: ${formatValue(report.summaryRebuildAccumulatorLifecycleEvidence.failedRequestCandidateRows)}`,
    '',
    `Rows joined to completed summary chunks: ${formatValue(report.summaryRebuildAccumulatorLifecycleEvidence.rowsJoinedToCompletedSummaryChunks)}`,
    '',
    report.summaryRebuildAccumulatorLifecycleEvidence.error
      ? `Status: Blocked: ${report.summaryRebuildAccumulatorLifecycleEvidence.error}`
      : 'Status: ok',
    '',
    summaryRebuildAccumulatorLifecycleRows.length > 0
      ? formatMarkdownTable(
          ['Request disposition', 'Request status', 'Admission state', 'Rows', 'Distinct requests'],
          summaryRebuildAccumulatorLifecycleRows,
        )
      : '_No summary rebuild accumulator request lifecycle rows were collected._',
    '',
    summaryRebuildAccumulatorBlockerRows.length > 0
      ? formatMarkdownTable(['Retention blocker/category', 'Rows'], summaryRebuildAccumulatorBlockerRows)
      : '_No summary rebuild accumulator blocker categories were collected._',
    '',
    '## Rebuild Request Lifecycle Field Evidence',
    '',
    `Verdict: ${
      report.rebuildRequestLifecycleFieldEvidence.verdict === 'not-authorized'
        ? 'not-authorized (not deletion/slimming authorization)'
        : 'blocked'
    }`,
    '',
    report.rebuildRequestLifecycleFieldEvidence.note,
    '',
    `Table: \`${report.rebuildRequestLifecycleFieldEvidence.table}\``,
    '',
    `Global rows: ${formatValue(report.rebuildRequestLifecycleFieldEvidence.globalRows)}`,
    '',
    `Current-project rows: ${formatValue(report.rebuildRequestLifecycleFieldEvidence.currentProjectRows)}`,
    '',
    report.rebuildRequestLifecycleFieldEvidence.error
      ? `Status: Blocked: ${report.rebuildRequestLifecycleFieldEvidence.error}`
      : 'Status: ok',
    '',
    rebuildRequestLifecycleColumnRows.length > 0
      ? formatMarkdownTable(
          [
            'Lifecycle column',
            'Global nulls',
            'Global non-nulls',
            'Current-project nulls',
            'Current-project non-nulls',
          ],
          rebuildRequestLifecycleColumnRows,
        )
      : '_No rebuild request lifecycle column evidence rows were collected._',
    '',
    rebuildRequestLifecycleReasonRows.length > 0
      ? formatMarkdownTable(
          ['Reason', 'Status', 'Admission state', 'Rows', 'Rows with any lifecycle field'],
          rebuildRequestLifecycleReasonRows,
        )
      : '_No rebuild request lifecycle reason/status rows were collected._',
    '',
    '## Selected-Import Staging Physical Evidence',
    '',
    `Verdict: ${report.selectedImportStagingPhysicalEvidence.verdict === 'not-authorized' ? 'not-authorized (evidence only; not cleanup or runtime-change authorization)' : 'blocked'}`,
    '',
    report.selectedImportStagingPhysicalEvidence.note,
    '',
    `Table: \`${report.selectedImportStagingPhysicalEvidence.table}\``,
    '',
    `Global staging rows: ${formatValue(report.selectedImportStagingPhysicalEvidence.globalRowCount)}`,
    '',
    `Global published staging rows: ${formatValue(report.selectedImportStagingPhysicalEvidence.globalPublishedRows)}`,
    '',
    `Global unpublished staging rows: ${formatValue(report.selectedImportStagingPhysicalEvidence.globalUnpublishedRows)}`,
    '',
    `Current-project staging rows: ${formatValue(report.selectedImportStagingPhysicalEvidence.currentProjectRows)}`,
    '',
    `Current-project published staging rows: ${formatValue(report.selectedImportStagingPhysicalEvidence.currentProjectPublishedRows)}`,
    '',
    `Current-project unpublished staging rows: ${formatValue(report.selectedImportStagingPhysicalEvidence.currentProjectUnpublishedRows)}`,
    '',
    report.selectedImportStagingPhysicalEvidence.error
      ? `Status: Blocked: ${report.selectedImportStagingPhysicalEvidence.error}`
      : 'Status: ok',
    '',
    selectedImportStagingPublishStateRows.length > 0
      ? formatMarkdownTable(['Publish state', 'Rows', 'Current-project rows'], selectedImportStagingPublishStateRows)
      : '_No selected-import staging publish-state rows were collected._',
    '',
    selectedImportStagingSourcePartitionRows.length > 0
      ? formatMarkdownTable(
          ['Source partition', 'Rows', 'Current-project rows', 'Published rows', 'Unpublished rows'],
          selectedImportStagingSourcePartitionRows,
        )
      : '_No selected-import staging source-partition rows were collected._',
    '',
    selectedImportStagingDuplicateRows.length > 0
      ? formatMarkdownTable(
          ['Probe', 'Key columns', 'Duplicate keys', 'Sample duplicate key rows'],
          selectedImportStagingDuplicateRows,
        )
      : '_No selected-import staging duplicate probes were collected._',
    '',
    '## Selected-Import Payload Slimming Readiness',
    '',
    `Verdict: ${report.selectedImportPayloadSlimmingReadiness.verdict === 'not-authorized' ? 'not deletion/slimming authorization' : 'blocked'}`,
    '',
    report.selectedImportPayloadSlimmingReadiness.note,
    '',
    `Selected-base scoped rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedBaseScopedRows)}`,
    '',
    `Active/LKG selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.activeOrLastKnownGoodSelectedImportRows)}`,
    '',
    `Candidate selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.candidateSelectedImportRows)}`,
    '',
    `Other selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.otherSelectedImportRows)}`,
    '',
    `Hot-field scoped rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.hotFieldScopedRows)}`,
    '',
    report.selectedImportPayloadSlimmingReadiness.comparisonStatus,
    '',
    report.selectedImportPayloadSlimmingReadiness.consumerWriterStatus,
    '',
    'Global/current-DB display-copy evidence is limited to `publication_year`, `article_title`, `journal_title`, and `external_id`. Post-drop databases report those columns as `retired/dropped` instead of binding absent physical columns. `import_route_id`, `source_record_key`, `selected_rank_key`, and `selected_rank_numeric` stay out of this claim and remain active identity/rank/source state.',
    '',
    `Global/current-DB selected-base rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDisplayCopyGlobalEvidence.totalRows)}`,
    '',
    `Global active/LKG protected selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDisplayCopyGlobalEvidence.activeOrLastKnownGoodRows)}`,
    '',
    `Global candidate selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDisplayCopyGlobalEvidence.candidateRows)}`,
    '',
    `Global other selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDisplayCopyGlobalEvidence.otherRows)}`,
    '',
    selectedImportDisplayCopyGlobalColumnRows.length > 0
      ? formatMarkdownTable(
          ['Global display-copy column', 'Status', 'Selected-base nulls', 'Selected-base non-nulls'],
          selectedImportDisplayCopyGlobalColumnRows,
        )
      : '_No global display-copy column evidence rows were collected._',
    '',
    selectedImportDisplayCopyGlobalStatusRows.length > 0
      ? formatMarkdownTable(
          [
            'Snapshot status',
            'Active/LKG protected',
            'Rows',
            'Protected rows',
            'Candidate rows',
            'Other rows',
            ...selectedImportDisplayCopyColumns.flatMap((column) => {
              return [`${column} nulls`, `${column} non-nulls`]
            }),
          ],
          selectedImportDisplayCopyGlobalStatusRows,
        )
      : '_No global selected-import display-copy status/protection rows were collected._',
    '',
    'Global/current-DB duplicate/conflict flag fallback evidence is read-only and uses retained selected-base identity `(import_route_id, article_id, source_record_key)` to resolve hot-field rows. Selected-base flag columns may already be retired/dropped; the protected contract is the retained identity plus hot-field/default fallback semantics.',
    '',
    report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.note,
    '',
    `Selected-base duplicate flag column status: ${report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.duplicateFlagStatus}`,
    '',
    `Selected-base conflict flag column status: ${report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.conflictFlagStatus}`,
    '',
    `Duplicate/conflict selected-base rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.totalRows)}`,
    '',
    `Duplicate/conflict active/LKG protected selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.activeOrLastKnownGoodRows)}`,
    '',
    `Duplicate/conflict candidate selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.candidateRows)}`,
    '',
    `Duplicate/conflict other selected-import rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.otherRows)}`,
    '',
    `Hot rows resolved by selected-base identity: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.hotResolvedRows)}`,
    '',
    `Selected-base rows without resolved hot rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.missingHotRows)}`,
    '',
    `Selected-base/default duplicate TRUE rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.selectedBaseDuplicateTrueRows)}`,
    '',
    `Hot duplicate TRUE rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.hotDuplicateTrueRows)}`,
    '',
    `Duplicate flag mismatches by IS DISTINCT FROM: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.duplicateMismatchRows)}`,
    '',
    `Selected-base/default duplicate false rows without hot fallback source: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.selectedBaseFalseOrDefaultDuplicateRowsWithoutHot)}`,
    '',
    `Selected-base/default duplicate TRUE rows without hot fallback source: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.selectedBaseTrueDuplicateRowsWithoutHot)}`,
    '',
    `Selected-base/default conflict TRUE rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.selectedBaseConflictTrueRows)}`,
    '',
    `Hot conflict TRUE rows: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.hotConflictTrueRows)}`,
    '',
    `Conflict flag mismatches by IS DISTINCT FROM: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.conflictMismatchRows)}`,
    '',
    `Selected-base/default conflict false rows without hot fallback source: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.selectedBaseFalseOrDefaultConflictRowsWithoutHot)}`,
    '',
    `Selected-base/default conflict TRUE rows without hot fallback source: ${formatValue(report.selectedImportPayloadSlimmingReadiness.selectedImportDuplicateConflictGlobalEvidence.selectedBaseTrueConflictRowsWithoutHot)}`,
    '',
    selectedImportDuplicateConflictStatusRows.length > 0
      ? formatMarkdownTable(
          [
            'Snapshot status',
            'Active/LKG protected',
            'Rows',
            'Protected rows',
            'Candidate rows',
            'Other rows',
            'Hot resolved',
            'Hot missing',
            'Selected dup TRUE',
            'Hot dup TRUE',
            'Dup mismatches',
            'Missing-hot dup false/default',
            'Missing-hot dup TRUE',
            'Selected conflict TRUE',
            'Hot conflict TRUE',
            'Conflict mismatches',
            'Missing-hot conflict false/default',
            'Missing-hot conflict TRUE',
          ],
          selectedImportDuplicateConflictStatusRows,
        )
      : '_No global duplicate/conflict status/protection rows were collected._',
    '',
    report.selectedImportPayloadSlimmingReadiness.error
      ? `Status: Blocked: ${report.selectedImportPayloadSlimmingReadiness.error}`
      : 'Status: ok',
    '',
    selectedImportPayloadRows.length > 0
      ? formatMarkdownTable(
          [
            'Column',
            'Selected-base status',
            'Selected-base nulls',
            'Selected-base non-nulls',
            'Active/LKG nulls',
            'Active/LKG non-nulls',
            'Candidate nulls',
            'Candidate non-nulls',
            'Other nulls',
            'Other non-nulls',
            'Hot-field nulls',
            'Hot-field non-nulls',
          ],
          selectedImportPayloadRows,
        )
      : '_No selected-import payload evidence rows were collected._',
    '',
    selectedImportSnapshotStatusRows.length > 0
      ? formatMarkdownTable(['Selected-import snapshot status', 'Rows'], selectedImportSnapshotStatusRows)
      : '_No selected-import snapshot status rows were collected._',
    '',
    '## Projector Watermark Nullable Field Evidence',
    '',
    `Verdict: ${
      report.projectorWatermarkNullableFieldEvidence.verdict === 'not-authorized'
        ? 'not-authorized (not deletion/slimming authorization)'
        : 'blocked'
    }`,
    '',
    report.projectorWatermarkNullableFieldEvidence.note,
    '',
    `Table: \`${report.projectorWatermarkNullableFieldEvidence.table}\``,
    '',
    `Global rows: ${formatValue(report.projectorWatermarkNullableFieldEvidence.globalRows)}`,
    '',
    `Current-project rows: ${formatValue(report.projectorWatermarkNullableFieldEvidence.currentProjectRows)}`,
    '',
    projectorWatermarkNullableColumnRows.length > 0
      ? formatMarkdownTable(
          ['Nullable column', 'Global nulls', 'Global non-nulls', 'Current-project nulls', 'Current-project non-nulls'],
          projectorWatermarkNullableColumnRows,
        )
      : '_No projector watermark nullable column evidence rows were collected._',
    '',
    projectorWatermarkProjectScopeRows.length > 0
      ? formatMarkdownTable(['Project scope', 'Rows'], projectorWatermarkProjectScopeRows)
      : '_No projector watermark project-scope rows were collected._',
    '',
    projectorWatermarkSourcePartitionRows.length > 0
      ? formatMarkdownTable(['Source partition', 'Rows'], projectorWatermarkSourcePartitionRows)
      : '_No projector watermark source-partition rows were collected._',
    '',
    '## Unassessed Queue Serving Readiness',
    '',
    `Verdict: ${report.unassessedQueueServingReadiness.verdict === 'not-authorized' ? 'not-authorized (not deletion/slimming authorization)' : 'blocked'}`,
    '',
    report.unassessedQueueServingReadiness.note,
    '',
    `Table: \`${report.unassessedQueueServingReadiness.table}\``,
    '',
    `Global rows: ${formatValue(report.unassessedQueueServingReadiness.globalRowCount)}`,
    '',
    `Current-project rows: ${formatValue(report.unassessedQueueServingReadiness.currentProjectRows)}`,
    '',
    `Active/LKG snapshot protected rows: ${formatValue(report.unassessedQueueServingReadiness.activeOrLastKnownGoodSnapshotProtectedRows)}`,
    '',
    `Pinned snapshot rows: ${formatValue(report.unassessedQueueServingReadiness.pinnedSnapshotRows)}`,
    '',
    `Candidate rows: ${formatValue(report.unassessedQueueServingReadiness.candidateRows)}`,
    '',
    `Other rows: ${formatValue(report.unassessedQueueServingReadiness.otherRows)}`,
    '',
    `Rows with missing snapshot manifest: ${formatValue(report.unassessedQueueServingReadiness.missingSnapshotManifestRows)}`,
    '',
    `Global prompt_id null rows: ${formatValue(report.unassessedQueueServingReadiness.promptNullness.globalNullPromptRows)}`,
    '',
    `Global prompt_id non-null rows: ${formatValue(report.unassessedQueueServingReadiness.promptNullness.globalNonNullPromptRows)}`,
    '',
    `Current-project prompt_id null rows: ${formatValue(report.unassessedQueueServingReadiness.promptNullness.currentProjectNullPromptRows)}`,
    '',
    `Current-project prompt_id non-null rows: ${formatValue(report.unassessedQueueServingReadiness.promptNullness.currentProjectNonNullPromptRows)}`,
    '',
    `Distinct articles: ${formatValue(report.unassessedQueueServingReadiness.distinctArticles)}`,
    '',
    `Distinct article/prompt pairs: ${formatValue(report.unassessedQueueServingReadiness.distinctPromptPairs)}`,
    '',
    `Column count: ${formatValue(report.unassessedQueueServingReadiness.columns.length)}`,
    '',
    `Index count: ${formatValue(report.unassessedQueueServingReadiness.indexes.length)}`,
    '',
    report.unassessedQueueServingReadiness.error
      ? `Status: Blocked: ${report.unassessedQueueServingReadiness.error}`
      : 'Status: ok',
    '',
    unassessedQueueProtectionStatusRows.length > 0
      ? formatMarkdownTable(
          [
            'Snapshot status',
            'Active/LKG protected',
            'Pinned protected',
            'Rows',
            'Current-project rows',
            'Candidate rows',
            'Other rows',
          ],
          unassessedQueueProtectionStatusRows,
        )
      : '_No unassessed queue snapshot protection/status rows were collected._',
    '',
    unassessedQueueKindRows.length > 0
      ? formatMarkdownTable(['Queue kind', 'Rows'], unassessedQueueKindRows)
      : '_No unassessed queue kind rows were collected._',
    '',
    unassessedQueueConsumerRows.length > 0
      ? formatMarkdownTable(
          ['Consumer shape', 'Global rows', 'Current-project rows', 'Read shape'],
          unassessedQueueConsumerRows,
        )
      : '_No unassessed queue consumer-shaped counts were collected._',
    '',
    unassessedQueueProjectRows.length > 0
      ? formatMarkdownTable(['Project', 'Rows'], unassessedQueueProjectRows)
      : '_No projects with nonzero unassessed queue serving rows were observed._',
    '',
    unassessedQueueDuplicateRows.length > 0
      ? formatMarkdownTable(['Probe', 'Key columns', 'Duplicate keys'], unassessedQueueDuplicateRows)
      : '_No unassessed queue duplicate probes were collected._',
    '',
    unassessedQueueColumnRows.length > 0
      ? formatMarkdownTable(['Column', 'Type'], unassessedQueueColumnRows)
      : '_No unassessed queue column shape was collected._',
    '',
    unassessedQueueIndexRows.length > 0
      ? formatMarkdownTable(['Index metadata'], unassessedQueueIndexRows)
      : '_No unassessed queue indexes were observed._',
    '',
    '## Rebuild Chunk Manifest Diagnostics Readiness',
    '',
    `Verdict: ${report.chunkManifestDiagnosticsReadiness.verdict === 'not-authorized' ? 'not-authorized (not deletion/slimming authorization)' : 'blocked'}`,
    '',
    report.chunkManifestDiagnosticsReadiness.note,
    '',
    `Table: \`${report.chunkManifestDiagnosticsReadiness.table}\``,
    '',
    `Current-project rows: ${formatValue(report.chunkManifestDiagnosticsReadiness.currentProjectRows)}`,
    '',
    `budget_json null rows: ${formatValue(report.chunkManifestDiagnosticsReadiness.budgetJsonNullRows)}`,
    '',
    `budget_json non-null rows: ${formatValue(report.chunkManifestDiagnosticsReadiness.budgetJsonNonNullRows)}`,
    '',
    `diagnostics_json null rows: ${formatValue(report.chunkManifestDiagnosticsReadiness.diagnosticsJsonNullRows)}`,
    '',
    `diagnostics_json non-null rows: ${formatValue(report.chunkManifestDiagnosticsReadiness.diagnosticsJsonNonNullRows)}`,
    '',
    `Rows with timing diagnostics: ${formatValue(report.chunkManifestDiagnosticsReadiness.timingDiagnosticsRows)}`,
    '',
    report.chunkManifestDiagnosticsReadiness.error
      ? `Status: Blocked: ${report.chunkManifestDiagnosticsReadiness.error}`
      : 'Status: ok',
    '',
    chunkDiagnosticsLifecycleRows.length > 0
      ? formatMarkdownTable(
          [
            'Status',
            'Admission',
            'Rows',
            'budget_json nulls',
            'budget_json non-nulls',
            'diagnostics_json nulls',
            'diagnostics_json non-nulls',
            'Timing diagnostics rows',
          ],
          chunkDiagnosticsLifecycleRows,
        )
      : '_No chunk manifest lifecycle diagnostic rows were collected._',
    '',
    chunkDiagnosticsProjectionRows.length > 0
      ? formatMarkdownTable(
          [
            'Projection component',
            'Rows',
            'budget_json non-nulls',
            'diagnostics_json non-nulls',
            'Timing diagnostics rows',
          ],
          chunkDiagnosticsProjectionRows,
        )
      : '_No chunk manifest projection-component diagnostic rows were collected._',
    '',
    '## Judgment Detail Payload Readiness',
    '',
    `Verdict: ${report.judgmentDetailPayloadReadiness.verdict === 'not-authorized' ? 'not-authorized (not deletion/slimming authorization)' : 'blocked'}`,
    '',
    report.judgmentDetailPayloadReadiness.note,
    '',
    `Table: \`${report.judgmentDetailPayloadReadiness.table}\``,
    '',
    `Global rows: ${formatValue(report.judgmentDetailPayloadReadiness.globalRowCount)}`,
    '',
    `Current-project rows: ${formatValue(report.judgmentDetailPayloadReadiness.currentProjectRows)}`,
    '',
    `detail scalar null rows: ${formatValue(report.judgmentDetailPayloadReadiness.judgmentPayloadNullRows)}`,
    '',
    `detail scalar non-null rows: ${formatValue(report.judgmentDetailPayloadReadiness.judgmentPayloadNonNullRows)}`,
    '',
    `answered_original non-null rows: ${formatValue(report.judgmentDetailPayloadReadiness.answeredOriginalNonNullRows)}`,
    '',
    `answered_original_as_array non-null rows: ${formatValue(report.judgmentDetailPayloadReadiness.answeredArrayNonNullRows)}`,
    '',
    report.judgmentDetailPayloadReadiness.error
      ? `Status: Blocked: ${report.judgmentDetailPayloadReadiness.error}`
      : 'Status: ok',
    '',
    judgmentDetailPayloadKindRows.length > 0
      ? formatMarkdownTable(
          [
            'Payload kind',
            'Rows',
            'Detail scalar non-nulls',
            'Judgment ID non-nulls',
            'Placeholder rows',
            'model id non-nulls (retired)',
            'answered_original non-nulls',
            'answered_original_as_array non-nulls',
          ],
          judgmentDetailPayloadKindRows,
        )
      : '_No judgment detail payload-kind rows were collected._',
    '',
    report.judgmentDetailPayloadReadiness.sourceJudgmentEvidence.note,
    '',
    `Current-project source judgment rows: ${formatValue(report.judgmentDetailPayloadReadiness.sourceJudgmentEvidence.currentProjectSourceJudgmentRows)}`,
    '',
    judgmentDetailListModeRows.length > 0
      ? formatMarkdownTable(['List mode', 'Rows', 'Detail scalar non-nulls'], judgmentDetailListModeRows)
      : '_No judgment detail list-mode rows were collected._',
    '',
    judgmentDetailPayloadTopLevelKeyRows.length > 0
      ? formatMarkdownTable(
          ['Payload kind', 'Top-level payload JSON key', 'Global rows with key', 'Current-project rows with key'],
          judgmentDetailPayloadTopLevelKeyRows,
        )
      : '_Judgment payload JSON has been scalarized; no top-level JSON key rows are collected._',
    '',
    '## Summary Contribution Serving Readiness',
    '',
    `Verdict: ${report.summaryContributionServingReadiness.verdict === 'not-authorized' ? 'not-authorized (not deletion authorization)' : 'blocked'}`,
    '',
    report.summaryContributionServingReadiness.note,
    '',
    `Table: \`${report.summaryContributionServingReadiness.table}\``,
    '',
    `Global rows: ${formatValue(report.summaryContributionServingReadiness.globalRowCount)}`,
    '',
    `Projects with nonzero rows: ${formatValue(report.summaryContributionServingReadiness.nonzeroProjectCount)}`,
    '',
    `Active/LKG snapshot protected rows: ${formatValue(report.summaryContributionServingReadiness.activeOrLastKnownGoodSnapshotProtectedRows)}`,
    '',
    `Pinned snapshot rows: ${formatValue(report.summaryContributionServingReadiness.pinnedSnapshotRows)}`,
    '',
    `Rows with missing snapshot manifest: ${formatValue(report.summaryContributionServingReadiness.missingSnapshotManifestRows)}`,
    '',
    `Recoverability classification: ${report.summaryContributionServingReadiness.recoverabilityClassification}`,
    '',
    report.summaryContributionServingReadiness.partialRebuildOverlap.note,
    '',
    `Contribution ledger rows: ${formatValue(report.summaryContributionServingReadiness.partialRebuildOverlap.contributionRows)}`,
    '',
    `Rebuild partial contribution rows: ${formatValue(report.summaryContributionServingReadiness.partialRebuildOverlap.partialRows)}`,
    '',
    `Contribution rows with exact common-column rebuild-partial overlap: ${formatValue(report.summaryContributionServingReadiness.partialRebuildOverlap.exactCommonColumnOverlapRows)}`,
    '',
    `Rebuild partial rows with exact common-column contribution overlap: ${formatValue(report.summaryContributionServingReadiness.partialRebuildOverlap.partialRowsWithExactCommonContribution)}`,
    '',
    report.summaryContributionServingReadiness.partialRebuildOverlap.error
      ? `Partial overlap status: Blocked: ${report.summaryContributionServingReadiness.partialRebuildOverlap.error}`
      : 'Partial overlap status: ok',
    '',
    `Column count: ${formatValue(report.summaryContributionServingReadiness.columnCount)}`,
    '',
    `Index count: ${formatValue(report.summaryContributionServingReadiness.indexes.length)}`,
    '',
    report.summaryContributionServingReadiness.error
      ? `Status: Blocked: ${report.summaryContributionServingReadiness.error}`
      : 'Status: ok',
    '',
    summaryContributionTopProjectRows.length > 0
      ? formatMarkdownTable(['Project', 'Rows'], summaryContributionTopProjectRows)
      : '_No projects with nonzero summary contribution serving rows were observed._',
    '',
    summaryContributionProjectRows.length > 0
      ? formatMarkdownTable(['Rows by project', 'Rows'], summaryContributionProjectRows)
      : '_No summary contribution project classification rows were collected._',
    '',
    summaryContributionComponentKindRows.length > 0
      ? formatMarkdownTable(['Component kind', 'Rows'], summaryContributionComponentKindRows)
      : '_No summary contribution component-kind classification rows were collected._',
    '',
    summaryContributionDefinitionVersionRows.length > 0
      ? formatMarkdownTable(['Summary definition version', 'Rows'], summaryContributionDefinitionVersionRows)
      : '_No summary contribution definition-version classification rows were collected._',
    '',
    summaryContributionContributionKeyRows.length > 0
      ? formatMarkdownTable(['Contribution key', 'Rows'], summaryContributionContributionKeyRows)
      : '_No summary contribution key classification rows were collected._',
    '',
    summaryContributionSnapshotStatusRows.length > 0
      ? formatMarkdownTable(['Snapshot status', 'Rows'], summaryContributionSnapshotStatusRows)
      : '_No summary contribution snapshot-status classification rows were collected._',
    '',
    summaryContributionRecoverabilityRows.length > 0
      ? formatMarkdownTable(
          [
            'Summary kind',
            'Contribution groups',
            'Final rows',
            'Matched final rows',
            'Missing final rows',
            'Mismatched final rows',
            'Final rows missing contribution group',
            'Status',
          ],
          summaryContributionRecoverabilityRows,
        )
      : '_No summary contribution recoverability comparisons were collected._',
    '',
    summaryContributionDuplicateRows.length > 0
      ? formatMarkdownTable(['Probe', 'Key columns', 'Duplicate keys'], summaryContributionDuplicateRows)
      : '_No summary contribution duplicate probes were collected._',
    '',
    summaryContributionColumnRows.length > 0
      ? formatMarkdownTable(['Column', 'Type'], summaryContributionColumnRows)
      : '_No summary contribution column shape was collected._',
    '',
    summaryContributionIndexRows.length > 0
      ? formatMarkdownTable(['Index metadata'], summaryContributionIndexRows)
      : '_No summary contribution indexes were observed._',
    '',
    ...sections,
    '',
  ].join('\n')
}

const emitReport = (report: EvidenceReport) => {
  const rendered = report.options.format === 'markdown' ? renderMarkdown(report) : JSON.stringify(report, null, 2)

  if (report.options.output) {
    writeFileSync(report.options.output, rendered)
    return
  }

  console.log(rendered)
}

const inspectPhysicalEvidence = (options: CliOptions) => {
  return Effect.acquireRelease(Effect.tryPromise(createDuckdbSnapshotForCli), deleteSnapshot).pipe(
    Effect.flatMap((snapshot) => {
      return Effect.acquireRelease(
        Effect.tryPromise(() => {
          return getSnapshotQueryRuntime(snapshot.snapshotPath)
        }),
        closeSnapshotQueryRuntime,
      ).pipe(
        Effect.flatMap((runtime) => {
          return Effect.tryPromise(async () => {
            const tables: TableEvidence[] = []

            for (const table of hotReviewServingTables) {
              tables.push(await getTableEvidence(runtime, table, options))
            }

            emitReport({
              chunkManifestDiagnosticsReadiness: await getChunkManifestDiagnosticsReadinessReport(
                runtime,
                options.projectId,
                options.limit,
              ),
              dirtyWorkRetentionEvidence: await getDirtyWorkRetentionEvidenceReport(
                runtime,
                options.projectId,
                options.limit,
              ),
              filteredCountServingPhysicalEvidence: await getFilteredCountServingPhysicalEvidenceReport(
                runtime,
                options.projectId,
                options.limit,
              ),
              generatedAt: new Date().toISOString(),
              hotPayloadProxyEvidence: await getHotPayloadProxyEvidenceReport(runtime, options.projectId),
              judgmentDetailPayloadReadiness: await getJudgmentDetailPayloadReadinessReport(
                runtime,
                options.projectId,
                options.limit,
              ),
              mode: 'readonly-snapshot',
              options,
              projectorWatermarkNullableFieldEvidence: await getProjectorWatermarkNullableFieldReport(
                runtime,
                options.projectId,
                options.limit,
              ),
              rebuildRequestLifecycleFieldEvidence: await getRebuildRequestLifecycleFieldReport(
                runtime,
                options.projectId,
                options.limit,
              ),
              rebuildArtifactDispositionEvidence: await getRebuildArtifactDispositionEvidenceReport(
                runtime,
                options.projectId,
                options.limit,
              ),
              retentionCleanupEligibility: await getRetentionCleanupEligibilityReport(runtime, options.projectId),
              selectedImportStagingPhysicalEvidence: await getSelectedImportStagingPhysicalEvidenceReport(
                runtime,
                options.projectId,
                options.limit,
              ),
              selectedImportPayloadSlimmingReadiness: await getSelectedImportPayloadSlimmingReadinessReport(
                runtime,
                options.projectId,
              ),
              summaryRebuildAccumulatorLifecycleEvidence: await getSummaryRebuildAccumulatorLifecycleEvidenceReport(
                runtime,
                options.projectId,
                options.limit,
              ),
              summaryContributionServingReadiness: await getSummaryContributionServingReadinessReport(
                runtime,
                options.limit,
              ),
              snapshotPath: snapshot.snapshotPath,
              tables,
              unassessedQueueServingReadiness: await getUnassessedQueueServingReadinessReport(
                runtime,
                options.projectId,
                options.limit,
              ),
            })
          })
        }),
      )
    }),
  )
}

if (import.meta.main) {
  await Effect.runPromise(Effect.scoped(inspectPhysicalEvidence(getCliOptions())))
}
