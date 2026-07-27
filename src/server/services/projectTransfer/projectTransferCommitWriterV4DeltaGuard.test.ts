import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

const commitWriterSource = readFileSync(new URL('./projectTransferCommitWriter.ts', import.meta.url), 'utf8')

const getFunctionSource = (functionName: string, nextFunctionName: string) => {
  const start = commitWriterSource.indexOf(`const ${functionName} =`)
  const end = commitWriterSource.indexOf(`\nconst ${nextFunctionName} =`, start + 1)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)

  return commitWriterSource.slice(start, end)
}

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

test('project transfer set-based judgment commit uses narrow projected rows for insert and deltas', () => {
  const insertJudgmentRowsSetBased = getFunctionSource('insertJudgmentRowsSetBased', 'insertJudgmentRows')
  const appendJudgmentDeltasSetBased = getFunctionSource(
    'appendProjectTransferJudgmentCreatedDeltasSetBased',
    'appendProjectTransferHumanJudgmentDeltas',
  )
  const assertJudgmentPlanRowsCommitSafe = getFunctionSource(
    'assertSetBasedJudgmentPlanRowsCommitSafe',
    'assertSetBasedJudgmentRowsDoNotDuplicate',
  )
  const judgmentTargetIdsSql = getFunctionSource(
    'getSetBasedJudgmentTargetIdsSql',
    'assertSetBasedJudgmentAssessmentPlanRowsCommitSafe',
  )

  expect(commitWriterSource).toContain('judgmentRows')
  expect(insertJudgmentRowsSetBased).toContain('loadSetBasedJudgmentRowsWorkTable')
  expect(insertJudgmentRowsSetBased).toContain('appendProjectTransferJudgmentCreatedDeltasSetBased')
  expect(insertJudgmentRowsSetBased).not.toContain('tx.queryJson<ProjectTransferInsertedJudgmentDeltaRow>')
  expect(insertJudgmentRowsSetBased).not.toContain('getSetBasedJudgmentRowsSql({context, now, projectId})')
  expect(assertJudgmentPlanRowsCommitSafe).toContain('rows.is_answered')
  expect(assertJudgmentPlanRowsCommitSafe).not.toContain('$.isAnswered')
  expect(appendJudgmentDeltasSetBased).toContain('FROM (${rowsSql}) rows')
  expect(appendJudgmentDeltasSetBased).toContain('project.id <> rows.project_id')
  expect(appendJudgmentDeltasSetBased).not.toContain('rows.reduce<Promise<AppendLlmJudgmentReviewServingDeltaInput[]>')
  expect(judgmentTargetIdsSql).toContain('context.tempTables.judgmentRows')
  expect(judgmentTargetIdsSql).not.toContain('getSetBasedJudgmentRowsSql')
})
