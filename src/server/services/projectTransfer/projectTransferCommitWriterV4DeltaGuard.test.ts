import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

const commitWriterSource = readFileSync(new URL('./projectTransferCommitWriter.ts', import.meta.url), 'utf8')

test('project transfer commit writer uses V4 deltas instead of legacy mart dirty fanout', () => {
  expect(commitWriterSource).not.toContain('getProjectMartDirtyRefreshStateService')
  expect(commitWriterSource).not.toContain('markProjectsDirtyAtomically')
  expect(commitWriterSource).not.toContain('markArticleProjectsDirtyAtomically')
  expect(commitWriterSource).not.toContain('projectTransferCommit.reusedArticleUpdate')
  expect(commitWriterSource).not.toContain('projectTransferCommit.import')

  expect(commitWriterSource).toContain('appendArticleReviewServingDeltas')
  expect(commitWriterSource).toContain('appendProjectScopeArticleReviewServingDeltas')
  expect(commitWriterSource).toContain('appendProjectReviewConfigReviewServingDelta')
  expect(commitWriterSource).toContain('appendReviewServingImportRunArticleDelta')
  expect(commitWriterSource).toContain('appendLlmJudgmentReviewServingDeltas')
  expect(commitWriterSource).toContain('appendHumanJudgmentReviewServingDeltas')
})
