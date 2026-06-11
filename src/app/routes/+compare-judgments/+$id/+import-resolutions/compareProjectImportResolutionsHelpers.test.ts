import {describe, expect, test} from 'bun:test'

import type {ComparisonProjectConflictResolutionTransferArtifact} from '../../../../../services/comparisonProjectsService.ts'
import {
  conflictResolutionImportInvalidJsonCopy,
  getAnalyzeImportDisabledReason,
  getCommitImportDisabledReason,
  getCommitSummaryStats,
  getImportSummaryStats,
  getMatchKeyLabel,
  getMatchKindLabel,
  getSkipReasonLabel,
  readConflictResolutionImportFile,
} from './compareProjectImportResolutionsHelpers.ts'

const transferArtifact: ComparisonProjectConflictResolutionTransferArtifact = {
  exportedAt: '2026-06-10T12:00:00.000Z',
  format: 'forska.comparisonProject.conflictResolution.transfer',
  rows: [
    {
      externalArticleId: 'external-1',
      identifiers: [],
      resolution: {label: 'Yes', mode: 'summary', value: 'yes'},
      sourceArticleRowId: 'article-1',
      sourceResolutionId: 'resolution-1',
      title: 'Article 1',
    },
  ],
  source: {
    comparisonProjectDescription: null,
    comparisonProjectId: 'source-comparison-project-1',
    comparisonProjectName: 'Source comparison',
  },
  version: 1,
}

describe('compare project import resolutions helpers', () => {
  test('parses a selected conflict-resolution JSON file', async () => {
    const file = new File([JSON.stringify(transferArtifact)], 'source-conflict-resolutions.json', {
      type: 'application/json',
    })

    const parsedFile = await readConflictResolutionImportFile(file)

    expect(parsedFile).toEqual({artifact: transferArtifact, fileName: 'source-conflict-resolutions.json', rowCount: 1})
  })

  test('returns a clear invalid JSON file error', async () => {
    const file = new File(['{"format":'], 'broken-conflict-resolutions.json', {type: 'application/json'})
    const error = await readConflictResolutionImportFile(file).then(
      () => {
        return null
      },
      (rejectedError: unknown) => {
        return rejectedError
      },
    )

    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : null).toBe(conflictResolutionImportInvalidJsonCopy)
  })

  test('requires analyze success and importable rows before commit', () => {
    expect(
      getCommitImportDisabledReason({
        analyzeSucceeded: false,
        hasArtifact: true,
        hasCommitted: false,
        importableCount: 1,
        isAnalyzing: false,
        isCommitting: false,
      }),
    ).toBe('Analyze the import before committing.')
    expect(
      getCommitImportDisabledReason({
        analyzeSucceeded: true,
        hasArtifact: true,
        hasCommitted: false,
        importableCount: 0,
        isAnalyzing: false,
        isCommitting: false,
      }),
    ).toBe('Analyze found no importable rows.')
    expect(
      getCommitImportDisabledReason({
        analyzeSucceeded: true,
        hasArtifact: true,
        hasCommitted: false,
        importableCount: 1,
        isAnalyzing: false,
        isCommitting: false,
      }),
    ).toBeNull()
  })

  test('keeps analyze disabled until a valid artifact is parsed', () => {
    expect(getAnalyzeImportDisabledReason({hasArtifact: false, isAnalyzing: false, isCommitting: false})).toBe(
      'Choose a valid JSON export file first.',
    )
    expect(getAnalyzeImportDisabledReason({hasArtifact: true, isAnalyzing: false, isCommitting: false})).toBeNull()
  })

  test('formats analyze result labels for tables and summary cards', () => {
    expect(getSkipReasonLabel('existing-target-resolution')).toBe('Existing target resolution')
    expect(getMatchKindLabel('article-id')).toBe('Article ID')
    expect(getMatchKindLabel('id-title')).toBe('External ID + title')
    expect(getMatchKeyLabel('id-title', 'external-1\u001ftitle 1')).toBe('external-1 / title 1')
    expect(
      getImportSummaryStats({
        deduped: 1,
        importable: 2,
        matched: 3,
        scanned: 4,
        skipped: 2,
        skippedAmbiguousTarget: 0,
        skippedConflicting: 0,
        skippedExisting: 1,
        skippedInvalidValue: 0,
        skippedNoTargetMatch: 1,
        skippedNoUsableKey: 0,
        skippedNotConflicting: 0,
        skippedUnsupportedMode: 0,
      }).map((stat) => {
        return [stat.label, stat.value]
      }),
    ).toEqual([
      ['Scanned', 4],
      ['Matched', 3],
      ['Will import', 2],
      ['Skipped', 2],
      ['Already resolved', 1],
      ['Deduped', 1],
    ])
  })

  test('formats commit result inserted and skipped counts', () => {
    expect(
      getCommitSummaryStats({
        deduped: 1,
        importable: 2,
        inserted: 1,
        matched: 3,
        scanned: 4,
        skipped: 2,
        skippedAmbiguousTarget: 0,
        skippedConflicting: 0,
        skippedExisting: 1,
        skippedInvalidValue: 0,
        skippedNoTargetMatch: 1,
        skippedNoUsableKey: 0,
        skippedNotConflicting: 0,
        skippedUnsupportedMode: 0,
      }).map((stat) => {
        return [stat.label, stat.value]
      }),
    ).toEqual([
      ['Inserted', 1],
      ['Skipped', 2],
    ])
  })
})
