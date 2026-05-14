import {expect, test} from 'bun:test'

import {createTransientJudgmentExecutionSnapshotsForClaims} from './judgmentExecutionSnapshotService.ts'

test('snapshot article resolution rejects ambiguous matches and ignores quarantined source records', async () => {
  let snapshotSql = ''

  await createTransientJudgmentExecutionSnapshotsForClaims(
    [
      {
        articleId: 'legacy-or-external-article-id',
        claimId: 'claim-1',
        claimedBy: 'server-1',
        jobId: 'job-1',
        promptId: 'prompt-1',
        queueRecordId: 'queue-1',
      },
    ],
    {
      queryJson: async (statement) => {
        snapshotSql = statement
        return []
      },
    },
  )

  expect(snapshotSql).toContain('COUNT(DISTINCT candidate.canonical_article_id) = 1')
  expect(snapshotSql).toContain('source_record.quarantined_at IS NULL')
  expect(snapshotSql).not.toContain('resolution_order = 1')
})

test('snapshot scoped import selection prefers the requested source identifier', async () => {
  let snapshotSql = ''

  await createTransientJudgmentExecutionSnapshotsForClaims(
    [
      {
        articleId: 'requested-external-id',
        claimId: 'claim-1',
        claimedBy: 'server-1',
        jobId: 'job-1',
        promptId: 'prompt-1',
        queueRecordId: 'queue-1',
      },
    ],
    {
      queryJson: async (statement) => {
        snapshotSql = statement
        return []
      },
    },
  )

  expect(snapshotSql).toContain('current_import.external_article_id = snapshot_request_project.article_id')
  expect(snapshotSql).toContain('selected_identifier_rank')
  expect(snapshotSql).toContain('source_record.external_article_id = snapshot_request_project.article_id')
  expect(snapshotSql).toContain('ORDER BY selected_identifier_rank ASC, selected_source_rank ASC')
})
