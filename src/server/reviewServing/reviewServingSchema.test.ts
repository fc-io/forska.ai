import {readdirSync, readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {expect, test} from 'bun:test'

import {reviewServingReadContractList} from './reviewServingReadContracts.ts'

const reviewServingPhase1MigrationPaths = [
  '../../db/duckdbMigrations/0097_reviewServingV4Foundation.sql',
  '../../db/duckdbMigrations/0098_reviewServingPayloadOrderColumns.sql',
  '../../db/duckdbMigrations/0099_reviewServingCountScopeAndDetailOptionTables.sql',
  '../../db/duckdbMigrations/0100_reviewServingFilterOptionValueKey.sql',
  '../../db/duckdbMigrations/0101_reviewServingFacetSummaryScope.sql',
  '../../db/duckdbMigrations/0102_reviewWriteOverlayReadSurface.sql',
  '../../db/duckdbMigrations/0103_reviewServingQueueIdentityPrimaryKey.sql',
  '../../db/duckdbMigrations/0105_reviewServingArticleMetadataStatus.sql',
  '../../db/duckdbMigrations/0106_reviewServingRemoveHotSourceMetadata.sql',
  '../../db/duckdbMigrations/0107_reviewServingRebuildRequest.sql',
  '../../db/duckdbMigrations/0109_reviewServingJudgmentDetailPayloadKindForwardMigration.sql',
  '../../db/duckdbMigrations/0112_reviewServingSummaryRebuildPartial.sql',
  '../../db/duckdbMigrations/0113_reviewServingSummaryContributionRebuildPartial.sql',
  '../../db/duckdbMigrations/0118_dropReviewQueuePatchV4.sql',
  '../../db/duckdbMigrations/0119_dropReviewHumanStatusPatchV4.sql',
  '../../db/duckdbMigrations/0120_dropReviewLlmStatusPatchV4.sql',
  '../../db/duckdbMigrations/0121_dropReviewArticleFilterPostingPatchV4.sql',
  '../../db/duckdbMigrations/0122_dropReviewArticleDisplayPatchV4.sql',
  '../../db/duckdbMigrations/0123_dropReviewTitleSearchActivitySortAt.sql',
  '../../db/duckdbMigrations/0124_dropReviewSelectedImportDisplayCopyColumns.sql',
  '../../db/duckdbMigrations/0125_reviewServingJudgmentDetailIsAnswered.sql',
  '../../db/duckdbMigrations/0126_dropReviewSelectedImportPatchV4.sql',
  '../../db/duckdbMigrations/0127_dropReviewTitleSearchUnusedColumns.sql',
  '../../db/duckdbMigrations/0128_dropReviewArticleServingIdentityCopyColumns.sql',
  '../../db/duckdbMigrations/0129_dropReviewFilterPostingStatsDerivedColumns.sql',
  '../../db/duckdbMigrations/0130_dropReviewFilterOptionPayloadJson.sql',
  '../../db/duckdbMigrations/0131_dropReviewArticleServingSelectedRankCopy.sql',
  '../../db/duckdbMigrations/0132_dropReviewPayloadBytes.sql',
  '../../db/duckdbMigrations/0133_dropReviewFilterPostingServingIdentity.sql',
  '../../db/duckdbMigrations/0134_dropReviewArticleServingReviewProgressCopy.sql',
  '../../db/duckdbMigrations/0135_reviewServingJudgmentDetailPromptScalars.sql',
  '../../db/duckdbMigrations/0136_dropReviewSummaryPartialServingKey.sql',
  '../../db/duckdbMigrations/0137_reviewServingJudgmentDetailHumanScalars.sql',
  '../../db/duckdbMigrations/0138_dropReviewJudgmentDetailModelId.sql',
  '../../db/duckdbMigrations/0139_dropReviewQueueServingIdentity.sql',
  '../../db/duckdbMigrations/0140_dropReviewFilterPostingServingUpdatedAt.sql',
  '../../db/duckdbMigrations/0141_dropReviewSummaryContributionServing.sql',
  '../../db/duckdbMigrations/0142_reviewRebuildPartialCleanupAuthorization.sql',
  '../../db/duckdbMigrations/0143_dropReviewSelectedImportBaseFlags.sql',
  '../../db/duckdbMigrations/0144_dropReviewProjectImportDeltaCursor.sql',
  '../../db/duckdbMigrations/0146_reviewServingPayloadDisplayFields.sql',
  '../../db/duckdbMigrations/0147_dropReviewFilterPostingStats.sql',
  '../../db/duckdbMigrations/0148_backfillReviewPayloadDisplayFields.sql',
  '../../db/duckdbMigrations/0149_dropReviewPayloadDisplayCopyColumns.sql',
  '../../db/duckdbMigrations/0150_dropReviewServingProjectorWatermarkLifecyclePlaceholders.sql',
  '../../db/duckdbMigrations/0151_backfillReviewPayloadServingCoverage.sql',
  '../../db/duckdbMigrations/0152_dropReviewArticleServingFullTextCopies.sql',
  '../../db/duckdbMigrations/0153_dropReviewPayloadServingUpdatedAt.sql',
  '../../db/duckdbMigrations/0154_dropReviewImportHotFieldProvenanceDebugColumns.sql',
  '../../db/duckdbMigrations/0155_dropReviewPayloadServingArticleCreatedAt.sql',
  '../../db/duckdbMigrations/0156_dropReviewPayloadFullTextPreview.sql',
  '../../db/duckdbMigrations/0157_dropReviewSummaryContributionPartialJsonKey.sql',
  '../../db/duckdbMigrations/0158_reviewJudgmentDetailListScalars.sql',
  '../../db/duckdbMigrations/0159_reviewJudgmentDetailDetailHydrationScalars.sql',
  '../../db/duckdbMigrations/0160_reviewJudgmentDetailHydrationSplit.sql',
  '../../db/duckdbMigrations/0161_dropReviewJudgmentHydrationPromptMetadata.sql',
  '../../db/duckdbMigrations/0162_dropReviewFilterPostingServingSortKey.sql',
  '../../db/duckdbMigrations/0163_dropReviewArticleServingDisplayCopies.sql',
  '../../db/duckdbMigrations/0164_rehydrateReviewPayloadDisplayColumns.sql',
  '../../db/duckdbMigrations/0165_dropReviewPayloadAbstractText.sql',
  '../../db/duckdbMigrations/0166_dropReviewArticleServingPublicationYear.sql',
  '../../db/duckdbMigrations/0167_dropReviewArticleServingSelectedFlagCopies.sql',
  '../../db/duckdbMigrations/0168_dropReviewArticleServingSelectedImportRouteId.sql',
  '../../db/duckdbMigrations/0169_dropReviewPayloadSourceMetadata.sql',
  '../../db/duckdbMigrations/0170_dropReviewArticleServingUpdatedAt.sql',
  '../../db/duckdbMigrations/0171_normalizeReviewJudgmentDetailListModeStorage.sql',
  '../../db/duckdbMigrations/0172_dropReviewJudgmentDetailHydrationStorage.sql',
  '../../db/duckdbMigrations/0173_dropReviewPayloadDisplayStorage.sql',
  '../../db/duckdbMigrations/0174_dropReviewArticleServingStatusCountCopies.sql',
  '../../db/duckdbMigrations/0175_dropReviewArticleServingPayload.sql',
  '../../db/duckdbMigrations/0176_dropReviewSummaryContributionRebuildPartial.sql',
  '../../db/duckdbMigrations/0177_reviewFilteredCountServing.sql',
  '../../db/duckdbMigrations/0178_reviewSummaryRebuildAccumulator.sql',
  '../../db/duckdbMigrations/0179_slimReviewTitleSearchTokenPostings.sql',
  '../../db/duckdbMigrations/0180_reviewFilterStateServing.sql',
  '../../db/duckdbMigrations/0181_compactReviewFilterPostingServing.sql',
  '../../db/duckdbMigrations/0182_normalizeReviewArticleServingListModes.sql',
  '../../db/duckdbMigrations/0183_backfillReviewArticleServingListModeStateFilters.sql',
  '../../db/duckdbMigrations/0184_dropReviewJudgmentDetailListModeKey.sql',
  '../../db/duckdbMigrations/0185_dropReviewFilterPostingLookupIndex.sql',
  '../../db/duckdbMigrations/0186_reviewServingDirtySourceWatermark.sql',
  '../../db/duckdbMigrations/0187_compactReviewUnassessedQueueServing.sql',
  '../../db/duckdbMigrations/0188_dropReviewTitleSearchTokenLookupIndex.sql',
  '../../db/duckdbMigrations/0189_dropReviewFilterOptionLookupIndex.sql',
  '../../db/duckdbMigrations/0190_dropReviewFilteredCountLookupIndex.sql',
  '../../db/duckdbMigrations/0191_dropReviewArticleServingListModeStateLookupIndex.sql',
  '../../db/duckdbMigrations/0192_dropReviewSummaryOptionUpdatedAt.sql',
  '../../db/duckdbMigrations/0193_dropReviewJudgmentDetailLlmPlaceholders.sql',
  '../../db/duckdbMigrations/0194_dropReviewFilteredCountComponentBreakoutColumns.sql',
] as const
const reviewServingPhase1MigrationSqlByPath = Object.fromEntries(
  reviewServingPhase1MigrationPaths.map((migrationPath) => {
    return [migrationPath, readFileSync(resolve(import.meta.dir, migrationPath), 'utf8')]
  }),
)
const schemaMigrationSql = reviewServingPhase1MigrationPaths
  .map((migrationPath) => {
    return reviewServingPhase1MigrationSqlByPath[migrationPath]
  })
  .join('\n')
const reviewServingFoundationSchemaSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0097_reviewServingV4Foundation.sql']
const payloadOrderForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0098_reviewServingPayloadOrderColumns.sql']
const countScopeForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath[
    '../../db/duckdbMigrations/0099_reviewServingCountScopeAndDetailOptionTables.sql'
  ]
const filterOptionValueForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0100_reviewServingFilterOptionValueKey.sql']
const facetSummaryScopeForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0101_reviewServingFacetSummaryScope.sql']
const articleMetadataStatusForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0105_reviewServingArticleMetadataStatus.sql']
const judgmentDetailPayloadKindForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath[
    '../../db/duckdbMigrations/0109_reviewServingJudgmentDetailPayloadKindForwardMigration.sql'
  ]
const reviewQueuePatchRetirementForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0118_dropReviewQueuePatchV4.sql']
const reviewHumanStatusPatchRetirementForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0119_dropReviewHumanStatusPatchV4.sql']
const reviewLlmStatusPatchRetirementForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0120_dropReviewLlmStatusPatchV4.sql']
const reviewArticleFilterPostingPatchRetirementForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0121_dropReviewArticleFilterPostingPatchV4.sql']
const reviewArticleDisplayPatchRetirementForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0122_dropReviewArticleDisplayPatchV4.sql']
const reviewTitleSearchActivitySortAtDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0123_dropReviewTitleSearchActivitySortAt.sql']
const reviewSelectedImportDisplayCopyColumnDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0124_dropReviewSelectedImportDisplayCopyColumns.sql']
const reviewJudgmentDetailIsAnsweredForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0125_reviewServingJudgmentDetailIsAnswered.sql']
const reviewJudgmentDetailPromptScalarsForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0135_reviewServingJudgmentDetailPromptScalars.sql']
const reviewSummaryPartialServingKeyDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0136_dropReviewSummaryPartialServingKey.sql']
const reviewJudgmentDetailHumanScalarsForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0137_reviewServingJudgmentDetailHumanScalars.sql']
const reviewJudgmentDetailModelIdDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0138_dropReviewJudgmentDetailModelId.sql']
const reviewJudgmentDetailListScalarsForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0158_reviewJudgmentDetailListScalars.sql']
const reviewJudgmentDetailHydrationScalarsForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0159_reviewJudgmentDetailDetailHydrationScalars.sql']
const reviewJudgmentDetailHydrationSplitForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0160_reviewJudgmentDetailHydrationSplit.sql']
const reviewJudgmentDetailHydrationPromptMetadataDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0161_dropReviewJudgmentHydrationPromptMetadata.sql']
const reviewArticleServingDisplayCopyDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0163_dropReviewArticleServingDisplayCopies.sql']
const reviewPayloadDisplayRehydrationForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0164_rehydrateReviewPayloadDisplayColumns.sql']
const reviewPayloadAbstractTextDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0165_dropReviewPayloadAbstractText.sql']
const reviewArticleServingPublicationYearDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0166_dropReviewArticleServingPublicationYear.sql']
const reviewArticleServingSelectedFlagCopyDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0167_dropReviewArticleServingSelectedFlagCopies.sql']
const reviewArticleServingSelectedImportRouteIdDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath[
    '../../db/duckdbMigrations/0168_dropReviewArticleServingSelectedImportRouteId.sql'
  ]
const reviewPayloadSourceMetadataDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0169_dropReviewPayloadSourceMetadata.sql']
const reviewArticleServingUpdatedAtDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0170_dropReviewArticleServingUpdatedAt.sql']
const reviewJudgmentDetailListModeStorageNormalizationForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath[
    '../../db/duckdbMigrations/0171_normalizeReviewJudgmentDetailListModeStorage.sql'
  ]
const reviewJudgmentDetailHydrationStorageDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0172_dropReviewJudgmentDetailHydrationStorage.sql']
const reviewPayloadDisplayStorageDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0173_dropReviewPayloadDisplayStorage.sql']
const reviewArticleServingStatusCountCopyDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0174_dropReviewArticleServingStatusCountCopies.sql']
const reviewPayloadServingDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0175_dropReviewArticleServingPayload.sql']
const reviewQueueServingIdentityDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0139_dropReviewQueueServingIdentity.sql']
const reviewQueueServingCompactForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0187_compactReviewUnassessedQueueServing.sql']
const reviewFilterPostingServingUpdatedAtDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0140_dropReviewFilterPostingServingUpdatedAt.sql']
const reviewSummaryContributionServingDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0141_dropReviewSummaryContributionServing.sql']
const reviewSelectedImportBaseFlagDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0143_dropReviewSelectedImportBaseFlags.sql']
const reviewProjectImportDeltaCursorDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0144_dropReviewProjectImportDeltaCursor.sql']
const reviewServingPayloadDisplayFieldsForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0146_reviewServingPayloadDisplayFields.sql']
const reviewSelectedImportPatchRetirementForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0126_dropReviewSelectedImportPatchV4.sql']
const reviewTitleSearchUnusedColumnDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0127_dropReviewTitleSearchUnusedColumns.sql']
const reviewTitleSearchTokenPostingSlimForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0179_slimReviewTitleSearchTokenPostings.sql']
const reviewTitleSearchTokenLookupIndexDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0188_dropReviewTitleSearchTokenLookupIndex.sql']
const reviewFilterOptionLookupIndexDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0189_dropReviewFilterOptionLookupIndex.sql']
const reviewFilteredCountLookupIndexDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0190_dropReviewFilteredCountLookupIndex.sql']
const reviewSummaryOptionUpdatedAtDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0192_dropReviewSummaryOptionUpdatedAt.sql']
const reviewJudgmentDetailLlmPlaceholderDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0193_dropReviewJudgmentDetailLlmPlaceholders.sql']
const reviewFilterStateServingForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0180_reviewFilterStateServing.sql']
const reviewFilterPostingServingCompactForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0181_compactReviewFilterPostingServing.sql']
const reviewFilterPostingServingLookupIndexDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0185_dropReviewFilterPostingLookupIndex.sql']
const reviewArticleServingListModeNormalizationForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0182_normalizeReviewArticleServingListModes.sql']
const reviewArticleServingIdentityCopyColumnDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath[
    '../../db/duckdbMigrations/0128_dropReviewArticleServingIdentityCopyColumns.sql'
  ]
const reviewFilterPostingStatsDerivedColumnDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0129_dropReviewFilterPostingStatsDerivedColumns.sql']
const reviewFilterPostingStatsDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0147_dropReviewFilterPostingStats.sql']
const reviewPayloadDisplayFieldBackfillForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0148_backfillReviewPayloadDisplayFields.sql']
const reviewPayloadDisplayCopyColumnDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0149_dropReviewPayloadDisplayCopyColumns.sql']
const reviewServingProjectorWatermarkLifecyclePlaceholderDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath[
    '../../db/duckdbMigrations/0150_dropReviewServingProjectorWatermarkLifecyclePlaceholders.sql'
  ]
const reviewPayloadServingCoverageBackfillForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0151_backfillReviewPayloadServingCoverage.sql']
const reviewPayloadUpdatedAtDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0153_dropReviewPayloadServingUpdatedAt.sql']
const reviewImportHotFieldProvenanceDebugColumnDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath[
    '../../db/duckdbMigrations/0154_dropReviewImportHotFieldProvenanceDebugColumns.sql'
  ]
const reviewPayloadArticleCreatedAtDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0155_dropReviewPayloadServingArticleCreatedAt.sql']
const reviewPayloadFullTextPreviewDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0156_dropReviewPayloadFullTextPreview.sql']
const reviewSummaryContributionPartialJsonKeyDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath[
    '../../db/duckdbMigrations/0157_dropReviewSummaryContributionPartialJsonKey.sql'
  ]
const reviewFilterOptionPayloadJsonDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0130_dropReviewFilterOptionPayloadJson.sql']
const reviewArticleServingSelectedRankCopyDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0131_dropReviewArticleServingSelectedRankCopy.sql']
const reviewFilterPostingServingIdentityDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0133_dropReviewFilterPostingServingIdentity.sql']
const reviewArticleServingReviewProgressCopyDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0134_dropReviewArticleServingReviewProgressCopy.sql']
const reviewFilteredCountServingForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath['../../db/duckdbMigrations/0177_reviewFilteredCountServing.sql']
const reviewFilteredCountComponentBreakoutDropForwardMigrationSql =
  reviewServingPhase1MigrationSqlByPath[
    '../../db/duckdbMigrations/0194_dropReviewFilteredCountComponentBreakoutColumns.sql'
  ]
const hotServingTables = [
  'mart.review_article_serving_base_v4',
  'mart.review_article_serving_list_mode_state_v4',
  'mart.review_article_filter_posting_serving_v4',
  'mart.review_article_count_serving_v4',
  'mart.review_filtered_count_serving_v4',
  'mart.review_filter_facet_serving_v4',
  'mart.review_filter_option_serving_v4',
  'mart.review_unassessed_queue_serving_v4',
] as const

const reviewServingPhase1Tables = [
  'app.import_run_article_delta',
  'app.review_change_delta',
  'app.review_source_change_outbox',
  'app.review_delta_reconciliation_cursor',
  'app.review_import_article_hot_field',
  'app.review_serving_dirty_work',
  'app.review_serving_dirty_work_ack',
  'app.review_serving_project_dirty_source_watermark',
  'app.review_serving_projector_watermark',
  'app.review_projection_identity_manifest',
  'app.review_rebuild_request',
  'app.review_rebuild_chunk_manifest',
  'app.review_selected_import_snapshot',
  'app.review_selected_article_import_v4',
  'app.review_serving_snapshot_manifest',
  'app.review_serving_snapshot_pin',
  'app.review_write_overlay',
  'app.review_bulk_operation_job',
  'app.review_search_job',
  'app.review_serving_retention_mark',
  'mart.review_title_search_serving_v4',
  'mart.review_article_serving_base_v4',
  'mart.review_article_serving_list_mode_state_v4',
  'mart.review_article_filter_posting_serving_v4',
  'mart.review_article_judgment_detail_serving_v4',
  'mart.review_article_summary_rebuild_accumulator_v4',
  'mart.review_article_count_serving_v4',
  'mart.review_filtered_count_serving_v4',
  'mart.review_filter_facet_serving_v4',
  'mart.review_filter_option_serving_v4',
  'mart.review_unassessed_queue_serving_v4',
] as const
const retiredReviewServingTables = new Set<string>([
  'mart.review_queue_patch_v4',
  'mart.review_human_status_patch_v4',
  'mart.review_llm_status_patch_v4',
  'mart.review_article_filter_posting_patch_v4',
  'mart.review_article_display_patch_v4',
  'mart.review_selected_import_patch_v4',
  'mart.review_article_summary_contribution_v4',
  'mart.review_filter_posting_stats_v4',
  'mart.review_article_judgment_detail_hydration_serving_v4',
  'mart.review_article_serving_payload_v4',
  'mart.review_article_summary_contribution_rebuild_partial_v4',
  'mart.review_article_summary_rebuild_partial_v4',
  'mart.review_article_filter_state_serving_v4',
  'app.review_rebuild_partial_cleanup_authorization',
])

const deltaEnvelopeColumns = [
  'delta_id',
  'change_kind',
  'source_table',
  'source_row_id',
  'source_operation',
  'source_partition',
  'source_high_water_mark',
  'source_updated_at',
  'idempotency_key',
  'payload_version',
  'payload_json',
  'created_at',
  'reconciled_at',
] as const

const escapeRegex = (value: string) => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const getLastDropTableIndex = (tableName: string) => {
  const dropMatches = [
    ...schemaMigrationSql.matchAll(new RegExp(`DROP TABLE(?: IF EXISTS)? ${escapeRegex(tableName)};`, 'g')),
  ]

  return dropMatches.at(-1)?.index ?? -1
}

const hasActiveIndex = (indexName: string) => {
  const createMatches = [
    ...schemaMigrationSql.matchAll(
      new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${escapeRegex(indexName)}\\b`, 'g'),
    ),
  ]
  const lastCreateIndex = createMatches.at(-1)?.index ?? -1
  const dropMatches = [
    ...schemaMigrationSql.matchAll(
      new RegExp(`DROP INDEX IF EXISTS (?:[a-z_][\\w]*\\.)?${escapeRegex(indexName)};`, 'g'),
    ),
  ]
  const lastDropIndex = dropMatches.at(-1)?.index ?? -1

  return lastCreateIndex > lastDropIndex
}

const getTableSql = (tableName: string) => {
  const directMatches = [
    ...schemaMigrationSql.matchAll(
      new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${escapeRegex(tableName)} \\([\\s\\S]*?\\n\\);`, 'g'),
    ),
  ]
  const renameMatches = [
    ...schemaMigrationSql.matchAll(
      new RegExp(
        `ALTER TABLE ([a-z_][\\w]*\\.[a-zA-Z_]\\w*)\\nRENAME TO ${escapeRegex(tableName.split('.').at(-1) ?? tableName)};`,
        'g',
      ),
    ),
  ]
  const lastRenameMatch = renameMatches.at(-1)
  const renamedTableName = lastRenameMatch?.[1]
  const renamedCreateMatches =
    renamedTableName === undefined
      ? []
      : [
          ...schemaMigrationSql.matchAll(
            new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${escapeRegex(renamedTableName)} \\([\\s\\S]*?\\n\\);`, 'g'),
          ),
        ]
  const lastDirectMatch = directMatches.at(-1)
  const lastRenamedCreateMatch = renamedCreateMatches.at(-1)
  const lastMatch =
    (lastRenameMatch?.index ?? -1) > (lastDirectMatch?.index ?? -1) ? lastRenamedCreateMatch : lastDirectMatch

  if (lastMatch === undefined) {
    return ''
  }

  const lastDropIndex = retiredReviewServingTables.has(tableName) ? getLastDropTableIndex(tableName) : -1

  return lastDropIndex > (lastMatch.index ?? -1) ? '' : lastMatch[0]
}

const getTableColumnSql = (tableName: string) => {
  const tableColumns = [...getTableColumns(tableName)].map((columnName) => {
    return `  ${columnName} <resolved>`
  })
  const alterColumnSql = [
    ...schemaMigrationSql.matchAll(
      new RegExp(`ALTER TABLE ${escapeRegex(tableName)} ADD COLUMN IF NOT EXISTS [^;]+;`, 'g'),
    ),
  ]
    .map((match) => {
      return match[0]
    })
    .join('\n')

  return `${getTableSql(tableName)}\n${tableColumns.join('\n')}\n${alterColumnSql}`
}

const getTableColumns = (tableName: string) => {
  if (retiredReviewServingTables.has(tableName)) {
    return new Set<string>()
  }

  const unqualifiedTableName = tableName.split('.').at(-1) ?? tableName
  const repairRenames = [
    ...schemaMigrationSql.matchAll(
      new RegExp(
        `ALTER TABLE ([a-z_][\\w]*\\.[a-z_][\\w]*) RENAME TO (?:[a-z_][\\w]*\\.)?${escapeRegex(unqualifiedTableName)};`,
        'g',
      ),
    ),
  ]
  const repairTableName = repairRenames.at(-1)?.[1]
  const sourceTableSql = repairTableName ? getTableSql(repairTableName) : getTableSql(tableName)
  const columns = new Set(
    [...sourceTableSql.matchAll(/^ {2}([a-z_][\w]*)\s+/gm)].map((match) => {
      return match[1]
    }),
  )
  const droppedColumnMatches = [
    ...schemaMigrationSql.matchAll(
      new RegExp(`ALTER TABLE ${escapeRegex(tableName)} DROP COLUMN IF EXISTS ([a-z_][\\w]*);`, 'g'),
    ),
  ]

  droppedColumnMatches.forEach((match) => {
    columns.delete(match[1])
  })

  return columns
}

const getPhysicalColumnNameFromContractField = (field: string) => {
  const firstToken = field.trim().split(/\s+/)[0] ?? ''
  const columnName = firstToken.replace(/^.*\./, '')

  return /^[a-z_][\w]*$/.test(columnName) ? columnName : null
}

const getContractPhysicalColumns = (contract: (typeof reviewServingReadContractList)[number]) => {
  return [
    ...new Set(
      [...contract.cursorFields, ...contract.sort.fields]
        .map(getPhysicalColumnNameFromContractField)
        .filter((columnName): columnName is string => {
          return columnName !== null
        }),
    ),
  ]
}

const getMissingColumns = (tableName: string, columnNames: readonly string[]) => {
  const tableSql = getTableColumnSql(tableName)

  return columnNames.filter((columnName) => {
    return !new RegExp(`\\b${escapeRegex(columnName)}\\b`).test(tableSql)
  })
}

test('Phase 1 schema migration creates every review-serving table', () => {
  const missingTables = reviewServingPhase1Tables.filter((tableName) => {
    return getTableSql(tableName).length === 0
  })

  expect(missingTables).toEqual([])
})

test('retired patch tables are absent from the active review-serving schema', () => {
  expect(getTableSql('mart.review_queue_patch_v4')).toBe('')
  expect(reviewQueuePatchRetirementForwardMigrationSql.trim()).toBe('DROP TABLE IF EXISTS mart.review_queue_patch_v4;')
  expect(getTableSql('mart.review_human_status_patch_v4')).toBe('')
  expect(reviewHumanStatusPatchRetirementForwardMigrationSql.trim()).toBe(
    'DROP TABLE IF EXISTS mart.review_human_status_patch_v4;',
  )
  expect(getTableSql('mart.review_llm_status_patch_v4')).toBe('')
  expect(reviewLlmStatusPatchRetirementForwardMigrationSql.trim()).toBe(
    'DROP TABLE IF EXISTS mart.review_llm_status_patch_v4;',
  )
  expect(getTableSql('mart.review_article_filter_posting_patch_v4')).toBe('')
  expect(reviewArticleFilterPostingPatchRetirementForwardMigrationSql.trim()).toBe(
    'DROP TABLE IF EXISTS mart.review_article_filter_posting_patch_v4;',
  )
  expect(getTableSql('mart.review_article_display_patch_v4')).toBe('')
  expect(reviewArticleDisplayPatchRetirementForwardMigrationSql.trim()).toBe(
    'DROP TABLE IF EXISTS mart.review_article_display_patch_v4;',
  )
})

test('title search serving schema drops repeated unused metadata and stores compact token postings', () => {
  expect(reviewTitleSearchActivitySortAtDropForwardMigrationSql).toContain('Retired by 0127')
  expect(reviewTitleSearchUnusedColumnDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_title_search_serving_v4_repair',
  )
  expect(reviewTitleSearchTokenPostingSlimForwardMigrationSql).toContain(
    'LIST(DISTINCT article_id ORDER BY article_id) AS article_ids',
  )
  expect(reviewTitleSearchTokenPostingSlimForwardMigrationSql).not.toContain('PRIMARY KEY')
  expect(reviewTitleSearchTokenLookupIndexDropForwardMigrationSql.trim()).toBe(
    [
      'DROP INDEX IF EXISTS mart.idx_review_title_search_serving_v4_token;',
      'DROP INDEX IF EXISTS idx_review_title_search_serving_v4_token;',
    ].join('\n'),
  )
  expect(reviewTitleSearchUnusedColumnDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_title_search_serving_v4_repair RENAME TO review_title_search_serving_v4;',
  )
  expect([...getTableColumns('mart.review_title_search_serving_v4')]).toEqual([
    'project_id',
    'search_identity',
    'project_scope_identity',
    'snapshot_id',
    'token',
    'article_ids',
  ])
  expect(schemaMigrationSql).not.toContain('title_prefix')
  expect(schemaMigrationSql).not.toContain('search_updated_at')
  expect(hasActiveIndex('idx_review_title_search_serving_v4_repaired_pk')).toBe(true)
  expect(hasActiveIndex('idx_review_title_search_serving_v4_token')).toBe(false)
})

test('selected import schema drops retired display-copy and selected-base flag columns', () => {
  expect(reviewSelectedImportDisplayCopyColumnDropForwardMigrationSql).toContain(
    'CREATE TABLE app.review_selected_article_import_v4_repair',
  )
  expect(reviewSelectedImportDisplayCopyColumnDropForwardMigrationSql).toContain(
    'ALTER TABLE app.review_selected_article_import_v4_repair RENAME TO review_selected_article_import_v4;',
  )
  expect([...getTableColumns('app.review_selected_article_import_v4')]).toEqual([
    'project_id',
    'project_scope_identity',
    'selected_import_snapshot_id',
    'article_id',
    'import_route_id',
    'source_record_key',
    'selected_rank_key',
    'selected_rank_numeric',
    'tombstone',
    'selected_import_updated_at',
  ])
  expect(reviewSelectedImportBaseFlagDropForwardMigrationSql).toContain(
    'CREATE TABLE app.review_selected_article_import_v4_flag_repair',
  )
  expect(reviewSelectedImportBaseFlagDropForwardMigrationSql).toContain(
    'DROP TABLE app.review_selected_article_import_v4;',
  )
  expect(reviewSelectedImportBaseFlagDropForwardMigrationSql).toContain(
    'ALTER TABLE app.review_selected_article_import_v4_flag_repair RENAME TO review_selected_article_import_v4;',
  )
  expect(reviewSelectedImportBaseFlagDropForwardMigrationSql).not.toContain('duplicate_flag')
  expect(reviewSelectedImportBaseFlagDropForwardMigrationSql).not.toContain('conflict_flag')
})

test('unassessed queue serving schema drops derived queue identity', () => {
  expect([...getTableColumns('mart.review_unassessed_queue_serving_v4')]).toEqual([
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'queue_kind',
    'priority_bucket',
    'activity_sort_at',
    'article_id',
    'prompt_ids',
    'queue_updated_at',
  ])
  expect(reviewQueueServingIdentityDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_unassessed_queue_serving_v4_without_queue_identity',
  )
  expect(reviewQueueServingIdentityDropForwardMigrationSql).toContain('MAX(queue_updated_at) AS queue_updated_at')
  expect(reviewQueueServingIdentityDropForwardMigrationSql).not.toContain('queue_identity VARCHAR')
  expect(reviewQueueServingCompactForwardMigrationSql).toContain('prompt_ids VARCHAR[] NOT NULL')
  expect(reviewQueueServingCompactForwardMigrationSql).toContain(
    'LIST(DISTINCT prompt_id ORDER BY prompt_id) FILTER (WHERE prompt_id IS NOT NULL)',
  )
  expect(reviewQueueServingCompactForwardMigrationSql).toContain('[]::VARCHAR[]')
  expect(reviewQueueServingCompactForwardMigrationSql).toContain(
    'PRIMARY KEY(project_id, review_config_hash, snapshot_id, queue_kind, priority_bucket, activity_sort_at, article_id)',
  )
})

test('projector watermark schema drops unused lifecycle placeholders', () => {
  const projectorWatermarkSql = getTableSql('app.review_serving_projector_watermark')

  expect(projectorWatermarkSql).toContain('import_route_id VARCHAR')
  expect(projectorWatermarkSql).not.toContain('snapshot_id')
  expect(projectorWatermarkSql).not.toContain('status VARCHAR')
  expect(projectorWatermarkSql).not.toContain('lease_owner')
  expect(projectorWatermarkSql).not.toContain('lease_expires_at')
  expect(projectorWatermarkSql).not.toContain('cursor_json')
  expect(projectorWatermarkSql).not.toContain('last_error')
  expect(reviewServingProjectorWatermarkLifecyclePlaceholderDropForwardMigrationSql).toContain(
    'CREATE TABLE app.review_serving_projector_watermark_repair',
  )
  expect(reviewServingProjectorWatermarkLifecyclePlaceholderDropForwardMigrationSql).toContain(
    'DROP TABLE app.review_serving_projector_watermark;',
  )
  expect(reviewServingProjectorWatermarkLifecyclePlaceholderDropForwardMigrationSql).not.toContain('snapshot_id')
  expect(reviewServingProjectorWatermarkLifecyclePlaceholderDropForwardMigrationSql).not.toContain('lease_owner')
  expect(reviewServingProjectorWatermarkLifecyclePlaceholderDropForwardMigrationSql).not.toContain('cursor_json')
  expect(reviewServingProjectorWatermarkLifecyclePlaceholderDropForwardMigrationSql).not.toContain('last_error')
})

test('summary rebuild accumulator schema replaces chunk partial fanout', () => {
  expect(getTableSql('mart.review_article_summary_rebuild_partial_v4')).toBe('')
  expect([...getTableColumns('mart.review_article_summary_rebuild_accumulator_v4')]).toEqual([
    'request_id',
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'summary_kind',
    'summary_identity',
    'list_mode_key',
    'count_kind',
    'summary_definition_version',
    'filter_key',
    'facet_kind',
    'facet_key',
    'facet_value',
    'prompt_id',
    'answer_id',
    'answer_value',
    'availability',
    'stale_reason',
    'count_value',
    'source_chunk_ids_key',
    'accumulator_updated_at',
  ])
  expect(schemaMigrationSql).toContain('CREATE TABLE IF NOT EXISTS mart.review_article_summary_rebuild_accumulator_v4')
  expect(schemaMigrationSql).toContain('DROP TABLE IF EXISTS mart.review_article_summary_rebuild_partial_v4;')
  expect(reviewSummaryPartialServingKeyDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_summary_rebuild_partial_v4_without_serving_key',
  )
  expect(reviewSummaryPartialServingKeyDropForwardMigrationSql).toContain('SUM(COALESCE(count_value, 0))')
  expect(reviewSummaryPartialServingKeyDropForwardMigrationSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_summary_rebuild_partial_v4_unique',
  )
  expect(schemaMigrationSql).not.toContain('serving_key VARCHAR')
})

test('Phase 1 schema migration creates every read-contract physical table', () => {
  const contractTables = [
    ...new Set(
      reviewServingReadContractList.map((contract) => {
        return contract.servingTable
      }),
    ),
  ]
  const missingTables = contractTables.filter((tableName) => {
    return getTableSql(tableName).length === 0
  })

  expect(missingTables).toEqual([])
})

const getRuntimeSourceFiles = (directoryPath: string): string[] => {
  return readdirSync(directoryPath, {withFileTypes: true}).flatMap((entry) => {
    const entryPath = resolve(directoryPath, entry.name)

    if (entry.isDirectory()) {
      return getRuntimeSourceFiles(entryPath)
    }

    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [entryPath] : []
  })
}

test('runtime review-serving code does not reference retired patch storage', () => {
  const runtimeSourceFiles = [
    ...getRuntimeSourceFiles(resolve(import.meta.dir, '.')),
    ...getRuntimeSourceFiles(resolve(import.meta.dir, '../workers')),
  ]
  const runtimeReferences = runtimeSourceFiles.flatMap((sourcePath) => {
    const source = readFileSync(sourcePath, 'utf8')
    const retiredReference = [...retiredReviewServingTables].find((tableName) => {
      return source.includes(tableName)
    })

    return retiredReference === undefined ? [] : [`${sourcePath}: ${retiredReference}`]
  })

  expect(runtimeReferences).toEqual([])
})

test('Phase 1 schema migration includes the common delta envelope', () => {
  expect(getMissingColumns('app.import_run_article_delta', deltaEnvelopeColumns)).toEqual([])
  expect(getMissingColumns('app.review_change_delta', deltaEnvelopeColumns)).toEqual([])
})

test('project import delta cursor is retired from the review-serving schema', () => {
  expect(getTableSql('app.review_project_import_delta_cursor')).toBe('')
  expect(reviewServingFoundationSchemaSql).not.toContain('app.review_project_import_delta_cursor')
  expect(reviewServingFoundationSchemaSql).not.toContain('idx_review_project_import_delta_cursor_route')
  expect(reviewProjectImportDeltaCursorDropForwardMigrationSql.trim()).toBe(
    [
      'DROP INDEX IF EXISTS app.idx_review_project_import_delta_cursor_route;',
      'DROP INDEX IF EXISTS idx_review_project_import_delta_cursor_route;',
      'DROP TABLE IF EXISTS app.review_project_import_delta_cursor;',
    ].join('\n'),
  )
})

test('Phase 1 schema migration separates logical snapshots from component bases and patches', () => {
  expect(
    getMissingColumns('mart.review_article_serving_v4', ['snapshot_id', 'base_generation', 'patch_watermark']),
  ).toEqual([])
  expect(getMissingColumns('app.review_serving_snapshot_manifest', ['required_components_json'])).toEqual([])
  expect(getMissingColumns('app.review_serving_snapshot_manifest', ['optional_components_json'])).toEqual([])
})

test('Phase 5B schema migration adds rebuild request admission above chunk manifests', () => {
  expect(
    getMissingColumns('app.review_rebuild_request', [
      'request_id',
      'project_id',
      'requested_components_json',
      'source_watermarks_json',
      'identity_json',
      'status',
      'admission_state',
      'retry_policy_json',
      'retry_after',
      'oom_category',
      'over_budget_reason',
      'diagnostics_json',
    ]),
  ).toEqual([])
  expect(
    getMissingColumns('app.review_rebuild_chunk_manifest', [
      'request_id',
      'parent_chunk_id',
      'split_depth',
      'snapshot_id',
      'snapshot_count',
      'retry_count',
      'retry_after',
      'oom_category',
      'over_budget_reason',
      'max_input_rows',
      'max_output_rows',
      'max_output_bytes',
      'max_payload_bytes',
      'max_prompt_count',
      'max_temp_bytes',
      'workload_class',
      'admission_state',
      'budget_json',
      'diagnostics_json',
    ]),
  ).toEqual([])
})

test('review-serving schema retires audited summary partial cleanup authorization', () => {
  expect(getTableSql('app.review_rebuild_partial_cleanup_authorization')).toBe('')
  expect(schemaMigrationSql).toContain('DROP TABLE IF EXISTS app.review_rebuild_partial_cleanup_authorization;')
})

test('Phase 1 schema migration keeps raw payloads out of import hot fields', () => {
  const hotFieldSql = getTableSql('app.review_import_article_hot_field')
  const hotFieldColumns = getTableColumns('app.review_import_article_hot_field')

  expect(hotFieldSql).toContain('selected_rank_key')
  expect(hotFieldSql).toContain('publication_year')
  expect(hotFieldSql).not.toContain('payload_json')
  expect(hotFieldSql).not.toContain('source_metadata JSON')
  expect(
    ['source_record_hash', 'duplicate_key', 'source_updated_at', 'created_at', 'updated_at'].filter((columnName) => {
      return hotFieldColumns.has(columnName)
    }),
  ).toEqual([])
  expect(reviewImportHotFieldProvenanceDebugColumnDropForwardMigrationSql).toContain(
    'CREATE TABLE app.review_import_article_hot_field_repair',
  )
  expect(reviewImportHotFieldProvenanceDebugColumnDropForwardMigrationSql).toContain(
    'ALTER TABLE app.review_import_article_hot_field_repair RENAME TO review_import_article_hot_field;',
  )
  expect(reviewImportHotFieldProvenanceDebugColumnDropForwardMigrationSql).not.toContain('DROP COLUMN')
})

test('Phase 1 schema migration keeps raw payloads out of hot serving tables', () => {
  expect(
    [...hotServingTables, 'mart.review_article_serving_payload_v4'].flatMap((tableName) => {
      return getTableSql(tableName).includes('source_metadata JSON') ? [tableName] : []
    }),
  ).toEqual([])
})

test('Phase 1 payload serving table is retired from the final schema', () => {
  expect(getTableSql('mart.review_article_serving_payload_v4')).toBe('')
  expect([...getTableColumns('mart.review_article_serving_payload_v4')]).toEqual([])
  expect(reviewPayloadServingDropForwardMigrationSql).toContain(
    'DROP INDEX IF EXISTS idx_review_article_serving_payload_v4_lookup;',
  )
  expect(reviewPayloadServingDropForwardMigrationSql).toContain(
    'DROP TABLE IF EXISTS mart.review_article_serving_payload_v4;',
  )
})

test('historical payload serving slimming migrations remain ordered before final retirement', () => {
  expect(reviewServingPayloadDisplayFieldsForwardMigrationSql).toContain(
    'Retired by 0149_dropReviewPayloadDisplayCopyColumns.sql',
  )
  expect(reviewServingPayloadDisplayFieldsForwardMigrationSql).not.toContain('CREATE TABLE')
  expect(reviewServingPayloadDisplayFieldsForwardMigrationSql).not.toContain('ALTER TABLE')
  expect(reviewPayloadDisplayFieldBackfillForwardMigrationSql).toContain(
    'Retired by 0149_dropReviewPayloadDisplayCopyColumns.sql',
  )
  expect(reviewPayloadDisplayFieldBackfillForwardMigrationSql).not.toContain('UPDATE')
  expect(reviewPayloadDisplayCopyColumnDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_payload_v4_repair',
  )
  expect(reviewPayloadDisplayCopyColumnDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadDisplayCopyColumnDropForwardMigrationSql).not.toContain('article_title VARCHAR')
  expect(reviewPayloadDisplayCopyColumnDropForwardMigrationSql).not.toContain('article_external_id VARCHAR')
  expect(reviewPayloadDisplayCopyColumnDropForwardMigrationSql).not.toContain('full_text_pdf')
  expect(reviewPayloadDisplayRehydrationForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_payload_v4_display_repair',
  )
  expect(reviewPayloadDisplayRehydrationForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_display_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadDisplayRehydrationForwardMigrationSql).not.toContain('selected_import_snapshot_id')
  expect(reviewPayloadDisplayRehydrationForwardMigrationSql).not.toContain('selected_hot.article_title')
  expect(reviewPayloadDisplayRehydrationForwardMigrationSql).not.toContain('article_title VARCHAR')
  expect(reviewPayloadDisplayRehydrationForwardMigrationSql).not.toContain('abstract_text VARCHAR')
  expect(reviewPayloadDisplayRehydrationForwardMigrationSql).not.toContain(
    'UPDATE mart.review_article_serving_payload_v4',
  )
  expect(reviewPayloadAbstractTextDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_payload_v4_abstract_text_repair',
  )
  expect(reviewPayloadAbstractTextDropForwardMigrationSql).toContain(
    'DROP TABLE mart.review_article_serving_payload_v4;',
  )
  expect(reviewPayloadAbstractTextDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_abstract_text_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadAbstractTextDropForwardMigrationSql).not.toContain('PRIMARY KEY')
  expect(reviewPayloadAbstractTextDropForwardMigrationSql).not.toContain('abstract_text VARCHAR')
  expect(reviewPayloadServingCoverageBackfillForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_payload_v4_coverage_repair',
  )
  expect(reviewPayloadServingCoverageBackfillForwardMigrationSql).toContain(
    'FROM mart.review_article_serving_v4 serving',
  )
  expect(reviewPayloadServingCoverageBackfillForwardMigrationSql).toContain(
    'FROM app.review_serving_snapshot_manifest manifest',
  )
  expect(reviewPayloadServingCoverageBackfillForwardMigrationSql).toContain(
    "json_extract_string(component_state.value, '$.projectionIdentity')",
  )
  expect(reviewPayloadServingCoverageBackfillForwardMigrationSql).not.toContain('article_title VARCHAR')
  expect(reviewPayloadServingCoverageBackfillForwardMigrationSql).not.toContain('full_text_pdf')
  expect(reviewPayloadUpdatedAtDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_payload_v4_updated_at_repair',
  )
  expect(reviewPayloadUpdatedAtDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_updated_at_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadUpdatedAtDropForwardMigrationSql).not.toContain('payload_updated_at')
  expect(reviewPayloadArticleCreatedAtDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_payload_v4_article_created_at_repair',
  )
  expect(reviewPayloadArticleCreatedAtDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_article_created_at_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadArticleCreatedAtDropForwardMigrationSql).not.toContain('article_created_at TIMESTAMPTZ')
  expect(reviewPayloadArticleCreatedAtDropForwardMigrationSql).not.toContain(
    'idx_review_article_serving_payload_v4_preview_order',
  )
  expect(reviewPayloadFullTextPreviewDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_payload_v4_full_text_preview_repair',
  )
  expect(reviewPayloadFullTextPreviewDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_full_text_preview_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadFullTextPreviewDropForwardMigrationSql).not.toContain('full_text_preview VARCHAR')
  expect(reviewPayloadFullTextPreviewDropForwardMigrationSql).not.toContain('abstract_text VARCHAR')
  expect(reviewPayloadFullTextPreviewDropForwardMigrationSql).not.toContain('article_title VARCHAR')
  expect(reviewPayloadSourceMetadataDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_payload_v4_source_metadata_repair',
  )
  expect(reviewPayloadSourceMetadataDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_source_metadata_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadSourceMetadataDropForwardMigrationSql).not.toContain('source_metadata JSON')
  expect(reviewPayloadSourceMetadataDropForwardMigrationSql).not.toContain("'source_metadata'")
  expect(reviewPayloadSourceMetadataDropForwardMigrationSql).not.toContain('article_title VARCHAR')
  expect(reviewPayloadDisplayStorageDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_payload_v4_display_storage_repair',
  )
  expect(reviewPayloadDisplayStorageDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_payload_v4_display_storage_repair RENAME TO review_article_serving_payload_v4;',
  )
  expect(reviewPayloadDisplayStorageDropForwardMigrationSql).not.toContain('article_title VARCHAR')
  expect(reviewPayloadDisplayStorageDropForwardMigrationSql).not.toContain('article_external_id VARCHAR')
  expect(reviewPayloadDisplayStorageDropForwardMigrationSql).not.toContain('article_updated_at TIMESTAMPTZ')
  expect(getLastDropTableIndex('mart.review_article_serving_payload_v4')).toBeGreaterThan(
    schemaMigrationSql.indexOf(reviewPayloadDisplayStorageDropForwardMigrationSql),
  )
})

test('Phase 1 article serving schema drops duplicated display metadata', () => {
  expect(
    getMissingColumns('mart.review_article_serving_v4', ['article_created_at', 'sort_key', 'activity_sort_at']),
  ).toEqual([])
  expect(
    getMissingColumns('mart.review_article_serving_v4', [
      'article_title',
      'article_external_id',
      'article_updated_at',
      'arxiv_id',
      'biorxiv_id',
      'medrxiv_id',
      'doi',
      'pmid',
      'journal_title',
      'url',
      'full_text_pdf',
      'full_text_fetched_at',
      'full_text_conversion_status',
    ]),
  ).toEqual([
    'article_title',
    'article_external_id',
    'article_updated_at',
    'arxiv_id',
    'biorxiv_id',
    'medrxiv_id',
    'doi',
    'pmid',
    'journal_title',
    'url',
    'full_text_pdf',
    'full_text_fetched_at',
    'full_text_conversion_status',
  ])
  const removedIdentityColumns = [
    'display_identity',
    'project_scope_identity',
    'selected_import_identity',
    'llm_status_identity',
    'human_status_identity',
    'posting_identity',
    'summary_identity',
    'payload_identity',
    'selected_rank_key',
    'review_opened',
    'review_sections_completed',
    'publication_year',
    'duplicate_flag',
    'conflict_flag',
    'selected_import_route_id',
    'serving_updated_at',
    'llm_status_key',
    'human_status_key',
    'llm_judged_prompt_count',
    'enabled_prompt_count',
    'human_answered_prompt_count',
  ]
  expect(
    [...getTableColumns('mart.review_article_serving_v4')].filter((columnName) => {
      return removedIdentityColumns.includes(columnName)
    }),
  ).toEqual([])
  expect(reviewArticleServingIdentityCopyColumnDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_v4_repair',
  )
  expect(reviewArticleServingSelectedRankCopyDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_v4_repair',
  )
  expect(reviewArticleServingSelectedRankCopyDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_v4_repair RENAME TO review_article_serving_v4;',
  )
  expect(reviewArticleServingReviewProgressCopyDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_v4_repair',
  )
  expect(reviewArticleServingDisplayCopyDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_v4_display_copy_repair',
  )
  expect(reviewArticleServingDisplayCopyDropForwardMigrationSql).toContain('DROP TABLE mart.review_article_serving_v4;')
  const articleServingDisplayCopyRepairSql = reviewArticleServingDisplayCopyDropForwardMigrationSql.slice(
    reviewArticleServingDisplayCopyDropForwardMigrationSql.indexOf(
      'CREATE TABLE mart.review_article_serving_v4_display_copy_repair',
    ),
  )
  expect(articleServingDisplayCopyRepairSql).not.toContain('article_title VARCHAR')
  expect(articleServingDisplayCopyRepairSql).not.toContain('article_external_id VARCHAR')
  expect(articleServingDisplayCopyRepairSql).not.toContain('journal_title VARCHAR')
  expect(articleServingDisplayCopyRepairSql).not.toContain('publication_year INTEGER')
  expect(reviewArticleServingPublicationYearDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_v4_publication_year_repair',
  )
  expect(reviewArticleServingPublicationYearDropForwardMigrationSql).toContain(
    'DROP TABLE mart.review_article_serving_v4;',
  )
  expect(reviewArticleServingPublicationYearDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_v4_publication_year_repair RENAME TO review_article_serving_v4;',
  )
  expect(reviewArticleServingPublicationYearDropForwardMigrationSql).not.toContain('publication_year INTEGER')
  expect(reviewArticleServingPublicationYearDropForwardMigrationSql).not.toContain(
    'CREATE INDEX IF NOT EXISTS idx_review_article_serving_v4_publication_year',
  )
  expect(reviewArticleServingSelectedFlagCopyDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_v4_selected_flag_repair',
  )
  expect(reviewArticleServingSelectedFlagCopyDropForwardMigrationSql).toContain(
    'DROP TABLE mart.review_article_serving_v4;',
  )
  expect(reviewArticleServingSelectedFlagCopyDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_v4_selected_flag_repair RENAME TO review_article_serving_v4;',
  )
  expect(reviewArticleServingSelectedFlagCopyDropForwardMigrationSql).not.toContain('duplicate_flag')
  expect(reviewArticleServingSelectedFlagCopyDropForwardMigrationSql).not.toContain('conflict_flag')
  expect(reviewArticleServingSelectedFlagCopyDropForwardMigrationSql).not.toContain('selected_import_route_id')
  expect(reviewArticleServingSelectedImportRouteIdDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_v4_selected_import_route_repair',
  )
  expect(reviewArticleServingSelectedImportRouteIdDropForwardMigrationSql).toContain(
    'DROP TABLE mart.review_article_serving_v4;',
  )
  expect(reviewArticleServingSelectedImportRouteIdDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_v4_selected_import_route_repair RENAME TO review_article_serving_v4;',
  )
  expect(reviewArticleServingSelectedImportRouteIdDropForwardMigrationSql).not.toContain(
    'selected_import_route_id VARCHAR',
  )
  expect(reviewArticleServingUpdatedAtDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_v4_updated_at_repair',
  )
  expect(reviewArticleServingUpdatedAtDropForwardMigrationSql).toContain('DROP TABLE mart.review_article_serving_v4;')
  expect(reviewArticleServingUpdatedAtDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_v4_updated_at_repair RENAME TO review_article_serving_v4;',
  )
  expect(reviewArticleServingUpdatedAtDropForwardMigrationSql).not.toContain('serving_updated_at')
  expect(reviewArticleServingStatusCountCopyDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_v4_status_count_repair',
  )
  expect(reviewArticleServingStatusCountCopyDropForwardMigrationSql).toContain(
    'DROP TABLE mart.review_article_serving_v4;',
  )
  expect(reviewArticleServingStatusCountCopyDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_serving_v4_status_count_repair RENAME TO review_article_serving_v4;',
  )
  expect(reviewArticleServingStatusCountCopyDropForwardMigrationSql).not.toContain('llm_status_key VARCHAR')
  expect(reviewArticleServingStatusCountCopyDropForwardMigrationSql).not.toContain('human_status_key VARCHAR')
  expect(reviewArticleServingStatusCountCopyDropForwardMigrationSql).not.toContain('enabled_prompt_count')
  const articleServingFoundationSchemaSql = reviewServingFoundationSchemaSql.slice(
    reviewServingFoundationSchemaSql.indexOf('CREATE TABLE IF NOT EXISTS mart.review_article_serving_v4'),
    reviewServingFoundationSchemaSql.indexOf('CREATE TABLE IF NOT EXISTS mart.review_article_display_patch_v4'),
  )
  expect(articleServingFoundationSchemaSql).not.toContain('duplicate_flag BOOLEAN')
  expect(articleServingFoundationSchemaSql).not.toContain('conflict_flag BOOLEAN')
  expect(articleServingFoundationSchemaSql).not.toContain('selected_import_route_id')
  expect(articleServingFoundationSchemaSql).not.toContain('serving_updated_at')
  expect(articleServingFoundationSchemaSql).not.toContain('llm_status_key')
  expect(articleServingFoundationSchemaSql).not.toContain('human_status_key')
  expect(articleServingFoundationSchemaSql).not.toContain('enabled_prompt_count')
  expect(reviewServingFoundationSchemaSql).not.toContain('idx_review_article_serving_v4_publication_year')
  expect(reviewArticleServingReviewProgressCopyDropForwardMigrationSql).not.toContain('review_opened')
  expect(reviewArticleServingReviewProgressCopyDropForwardMigrationSql).not.toContain('review_sections_completed')
  expect(articleMetadataStatusForwardMigrationSql).not.toContain('ALTER TABLE mart.review_article_serving_v4')
})

test('article serving list-mode normalization keeps logical rows on a compatibility view', () => {
  expect(reviewArticleServingListModeNormalizationForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_base_v4',
  )
  expect(reviewArticleServingListModeNormalizationForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_serving_list_mode_state_v4',
  )
  expect(reviewArticleServingListModeNormalizationForwardMigrationSql).toContain(
    'DROP TABLE mart.review_article_serving_v4;',
  )
  expect(reviewArticleServingListModeNormalizationForwardMigrationSql).toContain(
    'CREATE VIEW mart.review_article_serving_v4 AS',
  )
  expect(reviewArticleServingListModeNormalizationForwardMigrationSql).toContain(
    'CROSS JOIN unnest(state.list_mode_keys) AS list_mode(list_mode_key)',
  )
  expect(reviewArticleServingListModeNormalizationForwardMigrationSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_base_v4_pk',
  )
  expect(reviewArticleServingListModeNormalizationForwardMigrationSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_list_mode_state_v4_pk',
  )
  expect([...getTableColumns('mart.review_article_serving_base_v4')]).toEqual([
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'base_generation',
    'patch_watermark',
    'article_id',
    'article_created_at',
    'sort_key',
    'activity_sort_at',
  ])
  expect([...getTableColumns('mart.review_article_serving_list_mode_state_v4')]).toEqual([
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'article_id',
    'list_mode_keys',
    'llm_patch_watermark',
    'human_patch_watermark',
    'both_patch_watermark',
    'unassessed_patch_watermark',
    'duplicate_flag',
    'conflict_flag',
    'llm_status',
    'human_status',
    'llm_has_judgment',
  ])
  expect(reviewArticleServingListModeNormalizationForwardMigrationSql).toContain(
    'DROP TABLE IF EXISTS mart.review_article_filter_state_serving_v4;',
  )
  expect(reviewServingFoundationSchemaSql).toContain('CREATE TABLE IF NOT EXISTS mart.review_article_serving_v4')
  expect(reviewServingFoundationSchemaSql).not.toContain('CREATE VIEW mart.review_article_serving_v4')
})

test('selected import patch mart is retired from the review-serving schema', () => {
  expect(reviewSelectedImportPatchRetirementForwardMigrationSql).toContain(
    'DROP TABLE IF EXISTS mart.review_selected_import_patch_v4',
  )
  expect(schemaMigrationSql).not.toContain('CREATE TABLE IF NOT EXISTS mart.review_selected_import_patch_v4')
  expect(schemaMigrationSql).not.toContain('idx_review_selected_import_patch_v4_lookup')
  expect(reviewServingPhase1Tables).not.toContain('mart.review_selected_import_patch_v4')
  expect(retiredReviewServingTables.has('mart.review_selected_import_patch_v4')).toBe(true)
})

test('summary contribution serving mart is retired from the review-serving schema', () => {
  expect(reviewSummaryContributionServingDropForwardMigrationSql.trim()).toBe(
    [
      'DROP INDEX IF EXISTS mart.idx_review_article_summary_contribution_v4_lookup;',
      'DROP INDEX IF EXISTS idx_review_article_summary_contribution_v4_lookup;',
      'DROP TABLE IF EXISTS mart.review_article_summary_contribution_v4;',
    ].join('\n'),
  )
  expect(getTableSql('mart.review_article_summary_contribution_v4')).toBe('')
  expect(schemaMigrationSql).not.toContain('CREATE TABLE IF NOT EXISTS mart.review_article_summary_contribution_v4')
  expect(schemaMigrationSql).not.toContain(
    'CREATE INDEX IF NOT EXISTS idx_review_article_summary_contribution_v4_lookup',
  )
  expect(reviewServingPhase1Tables).not.toContain('mart.review_article_summary_contribution_v4')
  expect(retiredReviewServingTables.has('mart.review_article_summary_contribution_v4')).toBe(true)
})

test('summary contribution rebuild partial mart is retired from the final review-serving schema', () => {
  expect(getTableSql('mart.review_article_summary_contribution_rebuild_partial_v4')).toBe('')
  expect(schemaMigrationSql).toContain(
    'DROP TABLE IF EXISTS mart.review_article_summary_contribution_rebuild_partial_v4;',
  )
  expect(reviewServingPhase1Tables).not.toContain('mart.review_article_summary_contribution_rebuild_partial_v4')
  expect(retiredReviewServingTables.has('mart.review_article_summary_contribution_rebuild_partial_v4')).toBe(true)
  expect(reviewSummaryContributionPartialJsonKeyDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_summary_contribution_rebuild_partial_v4_key_repair',
  )
  expect(reviewSummaryContributionPartialJsonKeyDropForwardMigrationSql).toContain(
    "json_extract_string(contribution_key, '$.summaryKind') AS summary_kind",
  )
  expect(reviewSummaryContributionPartialJsonKeyDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_summary_contribution_rebuild_partial_v4_key_repair',
  )
  expect(reviewSummaryContributionPartialJsonKeyDropForwardMigrationSql).not.toContain('contribution_key VARCHAR')
})

test('filter posting stats mart is retired from the review-serving schema', () => {
  expect(reviewFilterPostingStatsDerivedColumnDropForwardMigrationSql.trim()).toBe(
    [
      '-- Retired by 0147_dropReviewFilterPostingStats.sql.',
      '-- Filter-posting stats are no longer materialized, so the old derived-column',
      '-- repair is intentionally skipped for fresh databases.',
    ].join('\n'),
  )
  expect(reviewFilterPostingStatsDropForwardMigrationSql.trim()).toBe(
    [
      'DROP INDEX IF EXISTS mart.idx_review_filter_posting_stats_v4_lookup;',
      'DROP INDEX IF EXISTS idx_review_filter_posting_stats_v4_lookup;',
      'DROP INDEX IF EXISTS mart.idx_review_filter_posting_stats_v4_repaired_pk;',
      'DROP INDEX IF EXISTS idx_review_filter_posting_stats_v4_repaired_pk;',
      'DROP TABLE IF EXISTS mart.review_filter_posting_stats_v4;',
    ].join('\n'),
  )
  expect(getTableSql('mart.review_filter_posting_stats_v4')).toBe('')
  expect(schemaMigrationSql).not.toContain('CREATE TABLE IF NOT EXISTS mart.review_filter_posting_stats_v4')
  expect(schemaMigrationSql).not.toContain('CREATE INDEX IF NOT EXISTS idx_review_filter_posting_stats_v4_lookup')
  expect(reviewServingPhase1Tables).not.toContain('mart.review_filter_posting_stats_v4')
  expect(retiredReviewServingTables.has('mart.review_filter_posting_stats_v4')).toBe(true)
  expect(schemaMigrationSql).not.toContain('selectivity DOUBLE')
  expect(getTableColumns('mart.review_article_filter_posting_serving_v4').has('posting_identity')).toBe(false)
  expect(reviewFilterPostingServingIdentityDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_filter_posting_serving_v4_repair',
  )
  expect(reviewFilterPostingServingIdentityDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_filter_posting_serving_v4_repair RENAME TO review_article_filter_posting_serving_v4;',
  )
  expect(reviewFilterPostingServingUpdatedAtDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_filter_posting_serving_v4_repair',
  )
  expect(reviewFilterPostingServingUpdatedAtDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_filter_posting_serving_v4_repair RENAME TO review_article_filter_posting_serving_v4;',
  )
  expect(reviewFilterPostingServingUpdatedAtDropForwardMigrationSql).not.toContain('posting_updated_at')
  expect(reviewFilterPostingServingIdentityDropForwardMigrationSql).not.toContain('sort_key TIMESTAMPTZ')
  expect(reviewFilterPostingServingUpdatedAtDropForwardMigrationSql).not.toContain('sort_key TIMESTAMPTZ')
  expect(getTableColumns('mart.review_article_filter_posting_serving_v4').has('posting_updated_at')).toBe(false)
})

test('filter posting serving schema stores compact article id postings without sort key', () => {
  expect([...getTableColumns('mart.review_article_filter_posting_serving_v4')]).toEqual([
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'filter_kind',
    'filter_value',
    'list_mode_key',
    'article_ids',
  ])
  expect(reviewFilterPostingServingCompactForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_filter_posting_serving_v4_repair',
  )
  expect(reviewFilterPostingServingCompactForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_filter_posting_serving_v4_repair RENAME TO review_article_filter_posting_serving_v4;',
  )
  expect(reviewFilterPostingServingCompactForwardMigrationSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_filter_posting_serving_v4_repaired_pk',
  )
  expect(reviewFilterPostingServingCompactForwardMigrationSql).toContain(
    'CREATE INDEX IF NOT EXISTS idx_review_article_filter_posting_serving_v4_lookup',
  )
  expect(reviewFilterPostingServingLookupIndexDropForwardMigrationSql.trim()).toBe(
    [
      'DROP INDEX IF EXISTS mart.idx_review_article_filter_posting_serving_v4_lookup;',
      'DROP INDEX IF EXISTS idx_review_article_filter_posting_serving_v4_lookup;',
    ].join('\n'),
  )
  expect(hasActiveIndex('idx_review_article_filter_posting_serving_v4_repaired_pk')).toBe(true)
  expect(hasActiveIndex('idx_review_article_filter_posting_serving_v4_lookup')).toBe(false)
  expect(reviewFilterPostingServingCompactForwardMigrationSql).toContain('article_ids VARCHAR[] NOT NULL')
  expect(reviewFilterPostingServingCompactForwardMigrationSql).toContain(
    'LIST(DISTINCT article_id ORDER BY article_id) AS article_ids',
  )
  expect(reviewFilterPostingServingCompactForwardMigrationSql).not.toContain('PRIMARY KEY')
  expect(reviewFilterPostingServingCompactForwardMigrationSql).not.toContain('sort_key TIMESTAMPTZ')
  expect(getTableSql('mart.review_article_filter_posting_serving_v4')).not.toContain('sort_key')
})

test('filter state serving table is retired into list-mode state', () => {
  expect([...getTableColumns('mart.review_article_filter_state_serving_v4')]).toEqual([])
  expect(reviewFilterStateServingForwardMigrationSql).toContain(
    "WHERE posting.filter_kind IN ('duplicateFlag', 'conflictFlag', 'llmStatus', 'humanStatus')",
  )
  expect(reviewFilterStateServingForwardMigrationSql).toContain(
    "DELETE FROM mart.review_article_filter_posting_serving_v4\nWHERE filter_kind IN ('duplicateFlag', 'conflictFlag', 'llmStatus', 'humanStatus')",
  )
  expect(reviewFilterStateServingForwardMigrationSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_filter_state_serving_v4_pk',
  )
  expect(retiredReviewServingTables.has('mart.review_article_filter_state_serving_v4')).toBe(true)
})

test('filter option schema drops reconstructable payload JSON column', () => {
  expect(reviewFilterOptionPayloadJsonDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_filter_option_serving_v4_repair',
  )
  expect(reviewFilterOptionLookupIndexDropForwardMigrationSql.trim()).toBe(
    [
      'DROP INDEX IF EXISTS mart.idx_review_filter_option_serving_v4_lookup;',
      'DROP INDEX IF EXISTS idx_review_filter_option_serving_v4_lookup;',
    ].join('\n'),
  )
  expect(reviewFilterOptionPayloadJsonDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_filter_option_serving_v4_repair RENAME TO review_filter_option_serving_v4;',
  )
  expect([...getTableColumns('mart.review_filter_option_serving_v4')]).toEqual([
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'search_identity',
    'filter_option_identity',
    'option_value_key',
    'filter_kind',
    'facet_key',
    'facet_value',
    'prompt_id',
    'answer_id',
    'numeric_min',
    'numeric_max',
    'count_value',
  ])
  expect(getTableColumns('mart.review_filter_option_serving_v4').has('option_payload_json')).toBe(false)
  expect(getTableColumns('mart.review_filter_option_serving_v4').has('option_updated_at')).toBe(false)
  expect(hasActiveIndex('idx_review_filter_option_serving_v4_repaired_pk')).toBe(true)
  expect(hasActiveIndex('idx_review_filter_option_serving_v4_lookup')).toBe(false)
})

test('summary and option mart schemas drop unused projection timestamps', () => {
  expect([...getTableColumns('mart.review_article_count_serving_v4')]).toEqual([
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'summary_identity',
    'list_mode_key',
    'count_kind',
    'summary_definition_version',
    'filter_key',
    'count_value',
    'availability',
    'stale_reason',
  ])
  expect([...getTableColumns('mart.review_filter_facet_serving_v4')]).toEqual([
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'summary_identity',
    'facet_kind',
    'facet_key',
    'facet_value',
    'prompt_id',
    'answer_id',
    'answer_value',
    'summary_definition_version',
    'count_value',
    'availability',
  ])
  expect(reviewSummaryOptionUpdatedAtDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_count_serving_v4_repair',
  )
  expect(reviewSummaryOptionUpdatedAtDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_filter_facet_serving_v4_repair',
  )
  expect(reviewSummaryOptionUpdatedAtDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_filter_option_serving_v4_repair',
  )
  expect(reviewSummaryOptionUpdatedAtDropForwardMigrationSql).not.toContain('count_updated_at TIMESTAMPTZ')
  expect(reviewSummaryOptionUpdatedAtDropForwardMigrationSql).not.toContain('facet_updated_at TIMESTAMPTZ')
  expect(reviewSummaryOptionUpdatedAtDropForwardMigrationSql).not.toContain('option_updated_at TIMESTAMPTZ')
  expect(getTableColumns('mart.review_article_count_serving_v4').has('count_updated_at')).toBe(false)
  expect(getTableColumns('mart.review_filter_facet_serving_v4').has('facet_updated_at')).toBe(false)
  expect(getTableColumns('mart.review_filtered_count_serving_v4').has('count_updated_at')).toBe(true)
  expect(getTableColumns('mart.review_article_judgment_detail_serving_v4').has('detail_updated_at')).toBe(true)
})

test('Phase 1 schema migration creates contract cursor and sort columns on non-job serving tables', () => {
  const missingColumns = reviewServingReadContractList
    .filter((contract) => {
      return contract.physicalAccessStrategy !== 'jobCriteria'
    })
    .flatMap((contract) => {
      const tableColumns = getTableColumns(contract.servingTable)

      return getContractPhysicalColumns(contract)
        .filter((columnName) => {
          if (
            contract.servingTable === 'mart.review_article_filter_posting_serving_v4'
            && (columnName === 'sort_key' || columnName === 'article_id')
          ) {
            return false
          }

          if (contract.servingTable === 'mart.review_title_search_serving_v4' && columnName === 'article_id') {
            return false
          }

          return !tableColumns.has(columnName)
        })
        .map((columnName) => {
          return `${contract.key}:${contract.servingTable}.${columnName}`
        })
    })

  expect(missingColumns).toEqual([])
})

test('Phase 1 schema migration keeps job contracts on job cursor and sort columns', () => {
  const jobContractFields = reviewServingReadContractList
    .filter((contract) => {
      return contract.physicalAccessStrategy === 'jobCriteria'
    })
    .flatMap((contract) => {
      return getContractPhysicalColumns(contract).map((columnName) => {
        return `${contract.key}:${columnName}`
      })
    })
  const invalidJobContractFields = jobContractFields.filter((field) => {
    return !field.endsWith(':updated_at') && !field.endsWith(':job_id')
  })

  expect(invalidJobContractFields).toEqual([])
})

test('payload order forward migration upgrades already-applied review-serving schemas', () => {
  expect(payloadOrderForwardMigrationSql).toContain('Retired by 0155_dropReviewPayloadServingArticleCreatedAt.sql')
  expect(payloadOrderForwardMigrationSql).not.toContain('ALTER TABLE')
  expect(payloadOrderForwardMigrationSql).not.toContain('CREATE INDEX')
})

test('Phase 1 schema migration keeps count rows list-mode scoped', () => {
  expect(getMissingColumns('mart.review_article_count_serving_v4', ['list_mode_key'])).toEqual([])
  expect(countScopeForwardMigrationSql).toContain('DROP TABLE IF EXISTS mart.review_article_count_serving_v4')
  expect(countScopeForwardMigrationSql).toContain("list_mode_key VARCHAR NOT NULL DEFAULT 'global'")
})

test('dynamic filtered count serving schema keys signatures by snapshot and component identities', () => {
  expect([...getTableColumns('mart.review_filtered_count_serving_v4')]).toEqual([
    'project_id',
    'review_config_hash',
    'snapshot_id',
    'list_mode_key',
    'filter_signature',
    'component_identity',
    'count_value',
    'count_updated_at',
  ])
  expect(reviewFilteredCountServingForwardMigrationSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_filtered_count_serving_v4_repaired_pk',
  )
  expect(reviewFilteredCountServingForwardMigrationSql).toContain('idx_review_filtered_count_serving_v4_lookup')
  expect(reviewFilteredCountLookupIndexDropForwardMigrationSql.trim()).toBe(
    [
      'DROP INDEX IF EXISTS mart.idx_review_filtered_count_serving_v4_lookup;',
      'DROP INDEX IF EXISTS idx_review_filtered_count_serving_v4_lookup;',
    ].join('\n'),
  )
  expect(reviewFilteredCountComponentBreakoutDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_filtered_count_serving_v4_repair',
  )
  expect(reviewFilteredCountComponentBreakoutDropForwardMigrationSql).toContain('count_updated_at TIMESTAMPTZ')
  expect(reviewFilteredCountComponentBreakoutDropForwardMigrationSql).not.toContain('project_scope_identity VARCHAR')
  expect(reviewFilteredCountComponentBreakoutDropForwardMigrationSql).not.toContain('search_identity VARCHAR')
  expect(reviewFilteredCountComponentBreakoutDropForwardMigrationSql).not.toContain('posting_identity VARCHAR')
  expect(reviewFilteredCountComponentBreakoutDropForwardMigrationSql).not.toContain('queue_identity VARCHAR')
  expect(reviewFilteredCountComponentBreakoutDropForwardMigrationSql).not.toContain('payload_identity VARCHAR')
  expect(hasActiveIndex('idx_review_filtered_count_serving_v4_repaired_pk')).toBe(true)
  expect(hasActiveIndex('idx_review_filtered_count_serving_v4_lookup')).toBe(false)
})

test('Phase 1 schema migration includes dedicated judgment detail and filter option tables', () => {
  expect(
    getMissingColumns('mart.review_article_judgment_detail_serving_v4', [
      'article_id',
      'prompt_id',
      'payload_kind',
      'is_answered',
      'judgment_created_at',
      'human_comment',
      'placeholder_kind',
    ]),
  ).toEqual([])
  expect(getTableColumns('mart.review_article_judgment_detail_serving_v4').has('model_id')).toBe(false)
  expect(getTableColumns('mart.review_article_judgment_detail_serving_v4').has('judgment_payload_json')).toBe(false)
  expect(getTableColumns('mart.review_article_judgment_detail_serving_v4').has('prompt_original_text')).toBe(false)
  expect(getTableColumns('mart.review_article_judgment_detail_serving_v4').has('judgment_updated_at')).toBe(false)
  expect(getTableColumns('mart.review_article_judgment_detail_serving_v4').has('judgment_model_id')).toBe(false)
  expect(getTableColumns('mart.review_article_judgment_detail_serving_v4').has('explanation')).toBe(false)
  expect(getTableColumns('mart.review_article_judgment_detail_serving_v4').has('quotes')).toBe(false)
  expect(getTableColumns('mart.review_article_judgment_detail_serving_v4').has('list_mode_key')).toBe(false)
  expect(getTableSql('mart.review_article_judgment_detail_hydration_serving_v4')).toBe('')
  expect(
    getMissingColumns('mart.review_filter_option_serving_v4', [
      'filter_kind',
      'filter_option_identity',
      'option_value_key',
      'search_identity',
    ]),
  ).toEqual([])
  expect(countScopeForwardMigrationSql).toContain(
    'CREATE TABLE IF NOT EXISTS mart.review_article_judgment_detail_serving_v4',
  )
  expect(countScopeForwardMigrationSql).toContain('DROP TABLE IF EXISTS mart.review_article_judgment_detail_serving_v4')
  expect(countScopeForwardMigrationSql).toContain("payload_kind VARCHAR NOT NULL DEFAULT 'llm'")
  expect(reviewJudgmentDetailIsAnsweredForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_serving_v4_is_answered_next',
  )
  expect(reviewJudgmentDetailIsAnsweredForwardMigrationSql).toContain('is_answered BOOLEAN')
  expect(reviewJudgmentDetailIsAnsweredForwardMigrationSql).toContain(
    "TRY_CAST(json_extract_string(judgment_payload_json, '$.isAnswered') AS BOOLEAN)",
  )
  expect(reviewJudgmentDetailIsAnsweredForwardMigrationSql).toContain(
    'RENAME TO review_article_judgment_detail_serving_v4',
  )
  expect(reviewJudgmentDetailPromptScalarsForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_serving_v4_prompt_scalars_next',
  )
  expect(reviewJudgmentDetailPromptScalarsForwardMigrationSql).toContain('prompt_original_text VARCHAR')
  expect(reviewJudgmentDetailPromptScalarsForwardMigrationSql).toContain('prompt_heading VARCHAR')
  expect(reviewJudgmentDetailPromptScalarsForwardMigrationSql).toContain('prompt_type VARCHAR')
  expect(reviewJudgmentDetailPromptScalarsForwardMigrationSql).toContain(
    'prompt_criteria_disposition project_prompt_criteria_disposition_v2',
  )
  expect(reviewJudgmentDetailPromptScalarsForwardMigrationSql).toContain(
    'CASE WHEN placeholder_kind IS NOT NULL THEN NULL ELSE judgment_payload_json END AS judgment_payload_json',
  )
  expect(reviewJudgmentDetailPromptScalarsForwardMigrationSql).toContain(
    'RENAME TO review_article_judgment_detail_serving_v4',
  )
  expect(reviewJudgmentDetailHydrationPromptMetadataDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_hydration_serving_v4_repair',
  )
  expect(reviewJudgmentDetailHydrationPromptMetadataDropForwardMigrationSql).not.toContain('prompt_original_text')
  expect(reviewJudgmentDetailHydrationPromptMetadataDropForwardMigrationSql).not.toContain('prompt_heading')
  expect(reviewJudgmentDetailHydrationPromptMetadataDropForwardMigrationSql).not.toContain('prompt_type')
  expect(reviewJudgmentDetailHydrationPromptMetadataDropForwardMigrationSql).not.toContain(
    'prompt_criteria_disposition',
  )
  expect(reviewJudgmentDetailHumanScalarsForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_serving_v4_human_scalars_next',
  )
  expect(reviewJudgmentDetailHumanScalarsForwardMigrationSql).toContain('judgment_created_at TIMESTAMPTZ')
  expect(reviewJudgmentDetailHumanScalarsForwardMigrationSql).toContain('human_comment VARCHAR')
  expect(reviewJudgmentDetailHumanScalarsForwardMigrationSql).toContain(
    "WHEN payload_kind = 'human' THEN json_extract_string(judgment_payload_json, '$.comment')",
  )
  expect(reviewJudgmentDetailHumanScalarsForwardMigrationSql).toContain(
    "WHEN payload_kind = 'human' OR placeholder_kind IS NOT NULL THEN NULL",
  )
  expect(reviewJudgmentDetailHumanScalarsForwardMigrationSql).toContain(
    'RENAME TO review_article_judgment_detail_serving_v4',
  )
  expect(reviewJudgmentDetailModelIdDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_serving_v4_repair',
  )
  expect(reviewJudgmentDetailModelIdDropForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_judgment_detail_serving_v4_repair RENAME TO review_article_judgment_detail_serving_v4;',
  )
  expect(reviewJudgmentDetailModelIdDropForwardMigrationSql).not.toContain('model_id VARCHAR')
  expect(reviewJudgmentDetailModelIdDropForwardMigrationSql).not.toContain('model_id,')
  expect(reviewJudgmentDetailListScalarsForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_serving_v4_repair',
  )
  expect(reviewJudgmentDetailListScalarsForwardMigrationSql).toContain('judgment_model_id VARCHAR')
  expect(reviewJudgmentDetailListScalarsForwardMigrationSql).toContain('explanation VARCHAR')
  expect(reviewJudgmentDetailListScalarsForwardMigrationSql).toContain('quotes JSON')
  expect(reviewJudgmentDetailListScalarsForwardMigrationSql).toContain(
    "json_extract_string(judgment_payload_json, '$.model.id')",
  )
  expect(reviewJudgmentDetailListScalarsForwardMigrationSql).toContain(
    "json_extract_string(judgment_payload_json, '$.explanation')",
  )
  expect(reviewJudgmentDetailListScalarsForwardMigrationSql).toContain(
    "json_extract(judgment_payload_json, '$.quotes')",
  )
  expect(reviewJudgmentDetailListScalarsForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_judgment_detail_serving_v4_repair RENAME TO review_article_judgment_detail_serving_v4;',
  )
  expect(reviewJudgmentDetailHydrationScalarsForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_serving_v4_repair',
  )
  expect(reviewJudgmentDetailHydrationScalarsForwardMigrationSql).toContain('judgment_updated_at TIMESTAMPTZ')
  expect(reviewJudgmentDetailHydrationScalarsForwardMigrationSql).toContain('chunking_strategy VARCHAR')
  expect(reviewJudgmentDetailHydrationScalarsForwardMigrationSql).toContain('confidence_original DOUBLE')
  expect(reviewJudgmentDetailHydrationScalarsForwardMigrationSql).toContain('model_name VARCHAR')
  expect(reviewJudgmentDetailHydrationScalarsForwardMigrationSql).toContain('assessment_id VARCHAR')
  expect(reviewJudgmentDetailHydrationScalarsForwardMigrationSql).toContain(
    "json_extract_string(judgment_payload_json, '$.updatedAt')",
  )
  expect(reviewJudgmentDetailHydrationScalarsForwardMigrationSql).toContain(
    "json_extract_string(judgment_payload_json, '$.confidenceOriginal')",
  )
  expect(reviewJudgmentDetailHydrationScalarsForwardMigrationSql).toContain(
    "json_extract_string(judgment_payload_json, '$.model.thinking')",
  )
  expect(reviewJudgmentDetailHydrationScalarsForwardMigrationSql).toContain(
    "json_extract_string(judgment_payload_json, '$.assessments[0].id')",
  )
  expect(reviewJudgmentDetailHydrationScalarsForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_judgment_detail_serving_v4_repair RENAME TO review_article_judgment_detail_serving_v4;',
  )
  expect(reviewJudgmentDetailHydrationSplitForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_hydration_serving_v4',
  )
  expect(reviewJudgmentDetailHydrationSplitForwardMigrationSql).toContain(
    'INSERT INTO mart.review_article_judgment_detail_hydration_serving_v4',
  )
  expect(reviewJudgmentDetailHydrationSplitForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_serving_v4_repair',
  )
  expect(reviewJudgmentDetailHydrationSplitForwardMigrationSql).toContain(
    'ALTER TABLE mart.review_article_judgment_detail_serving_v4_repair RENAME TO review_article_judgment_detail_serving_v4;',
  )
  expect(reviewJudgmentDetailHydrationSplitForwardMigrationSql).not.toContain('judgment_payload_json')
  expect(reviewJudgmentDetailHydrationSplitForwardMigrationSql).toContain(
    'CREATE INDEX IF NOT EXISTS idx_review_article_judgment_detail_hydration_serving_v4_article',
  )
  expect(reviewJudgmentDetailHydrationStorageDropForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_serving_v4_repair',
  )
  expect(reviewJudgmentDetailHydrationStorageDropForwardMigrationSql).toContain(
    'DROP TABLE IF EXISTS mart.review_article_judgment_detail_hydration_serving_v4;',
  )
  expect(reviewJudgmentDetailHydrationStorageDropForwardMigrationSql).not.toContain('judgment_model_id VARCHAR')
  expect(reviewJudgmentDetailHydrationStorageDropForwardMigrationSql).not.toContain('explanation VARCHAR')
  expect(reviewJudgmentDetailHydrationStorageDropForwardMigrationSql).not.toContain('quotes JSON')
  expect(reviewJudgmentDetailLlmPlaceholderDropForwardMigrationSql).toContain(
    "WHERE payload_kind = 'llm'\n  AND placeholder_kind = 'llm.unanswered'",
  )
  expect(reviewJudgmentDetailLlmPlaceholderDropForwardMigrationSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_judgment_detail_serving_v4_repaired_pk',
  )
  expect(reviewJudgmentDetailLlmPlaceholderDropForwardMigrationSql).toContain(
    'CREATE INDEX IF NOT EXISTS idx_review_article_judgment_detail_serving_v4_article',
  )
  expect(reviewJudgmentDetailLlmPlaceholderDropForwardMigrationSql).not.toContain('detail_updated_at')
  expect(countScopeForwardMigrationSql).toContain(
    'PRIMARY KEY(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id)',
  )
  expect(countScopeForwardMigrationSql).toContain('CREATE TABLE IF NOT EXISTS mart.review_filter_option_serving_v4')
  expect(countScopeForwardMigrationSql).toContain('option_value_key VARCHAR NOT NULL')
  expect(filterOptionValueForwardMigrationSql).toContain('DROP TABLE IF EXISTS mart.review_filter_option_serving_v4')
  expect(filterOptionValueForwardMigrationSql).toContain('option_value_key VARCHAR NOT NULL')
})

test('judgment detail list-mode normalization keeps only canonical payload identities', () => {
  expect(reviewJudgmentDetailListModeStorageNormalizationForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_serving_v4_repair',
  )
  expect(reviewJudgmentDetailListModeStorageNormalizationForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_hydration_serving_v4_repair',
  )
  expect(reviewJudgmentDetailListModeStorageNormalizationForwardMigrationSql).toContain(
    "WHEN payload_kind = 'human' THEN 'human'",
  )
  expect(reviewJudgmentDetailListModeStorageNormalizationForwardMigrationSql).toContain(
    "WHEN payload_kind = 'llm' THEN 'llm'",
  )
  expect(reviewJudgmentDetailListModeStorageNormalizationForwardMigrationSql).toContain(
    'PARTITION BY project_id, review_config_hash, snapshot_id, payload_kind, article_id, prompt_id',
  )
  expect(reviewJudgmentDetailListModeStorageNormalizationForwardMigrationSql).toContain(
    "WHEN list_mode_key = 'both' THEN 1",
  )
  expect(reviewJudgmentDetailListModeStorageNormalizationForwardMigrationSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_judgment_detail_serving_v4_payload_identity',
  )
  expect(reviewJudgmentDetailListModeStorageNormalizationForwardMigrationSql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_judgment_detail_hydration_serving_v4_payload_identity',
  )
  expect(reviewJudgmentDetailListModeStorageNormalizationForwardMigrationSql).not.toContain('PRIMARY KEY')
})

test('judgment detail payload-kind forward migration repairs already-applied V4 table shape', () => {
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain(
    "ALTER TABLE mart.review_article_judgment_detail_serving_v4\nADD COLUMN IF NOT EXISTS payload_kind VARCHAR DEFAULT 'llm';",
  )
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain(
    'CREATE TABLE mart.review_article_judgment_detail_serving_v4_payload_kind_next',
  )
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain(
    'PRIMARY KEY(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id)',
  )
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain(
    "SELECT\n  project_id,\n  review_config_hash,\n  snapshot_id,\n  list_mode_key,\n  COALESCE(payload_kind, 'llm') AS payload_kind,",
  )
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain(
    'ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, article_id, payload_kind, prompt_order);',
  )
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain('UPDATE app.review_rebuild_request AS request')
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain('UPDATE app.review_rebuild_chunk_manifest')
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain("projection_component = 'judgmentInputContent'")
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain("request.status IN ('failed', 'blocked_over_budget')")
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain(
    "chunk.status IN ('failed', 'blocked_over_budget', 'quarantined')",
  )
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain('newer_request.project_id = request.project_id')
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain(
    "status IN ('failed', 'blocked_over_budget', 'quarantined')",
  )
  expect(judgmentDetailPayloadKindForwardMigrationSql).toContain(
    'last_error ILIKE \'%Referenced column "payload_kind" not found%\'',
  )
})

test('Phase 1 schema migration keeps facets scoped by summary and facet kind in the final table shape', () => {
  expect(
    getMissingColumns('mart.review_filter_facet_serving_v4', [
      'answer_value',
      'facet_kind',
      'facet_key',
      'facet_value',
      'prompt_id',
      'summary_definition_version',
      'summary_identity',
    ]),
  ).toEqual([])
  expect(facetSummaryScopeForwardMigrationSql).toContain('DROP TABLE IF EXISTS mart.review_filter_facet_serving_v4')
  expect(facetSummaryScopeForwardMigrationSql).toContain(
    'PRIMARY KEY(project_id, review_config_hash, snapshot_id, summary_identity, facet_kind, facet_key, facet_value, summary_definition_version)',
  )
})
