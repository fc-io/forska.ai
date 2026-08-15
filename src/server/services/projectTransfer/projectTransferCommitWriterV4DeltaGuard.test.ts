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

test('project transfer set-based judgment commit never materializes full app-side judgment rows', () => {
  const setBasedWrite = getFunctionSource('writeSetBasedJudgments', 'writeMaterializedJudgments')
  const materializedWrite = getFunctionSource('writeMaterializedJudgments', 'getAssessmentSignature')
  const setBasedIdMap = getFunctionSource('getSetBasedJudgmentIdBySourceId', 'writeSetBasedJudgments')

  expect(setBasedWrite).toContain('await insertJudgmentRowsSetBased({context, now, projectId, tx})')
  expect(setBasedWrite).toContain('getSetBasedJudgmentIdBySourceId({commitIdMaps, judgmentPlan})')
  expect(setBasedWrite).not.toContain('getJudgmentRows')
  expect(setBasedWrite).not.toContain('judgments.length')
  expect(materializedWrite).toContain('const rows = getJudgmentRows({')
  expect(setBasedIdMap).toContain('commitIdMaps.judgmentIdBySourceId')
  expect(setBasedIdMap).toContain('entry.targetJudgmentId')
  expect(commitWriterSource).not.toContain('const judgmentRows = getJudgmentRows({')
})

test('project transfer created articles use the bulk review-serving delta path', () => {
  const appendCreatedArticleDeltas = getFunctionSource(
    'appendProjectTransferCreatedArticleDeltas',
    'getTransferArticleReviewServingFields',
  )

  expect(appendCreatedArticleDeltas).toContain('appendArticleReviewServingDeltasForIds')
  expect(appendCreatedArticleDeltas).not.toContain('articleIds.reduce')
  expect(appendCreatedArticleDeltas).not.toContain('appendArticleReviewServingDeltas(tx')
})

test('project transfer import routes use bounded bulk hot-field and delta paths', () => {
  const appendImportRouteDeltas = getFunctionSource(
    'appendProjectTransferArticleImportRouteReviewServingDeltas',
    'getResolvedArticleIdBySourceId',
  )

  expect(appendImportRouteDeltas).toContain('upsertReviewImportArticleHotFields')
  expect(appendImportRouteDeltas).toContain('appendReviewServingImportRunArticleDeltas')
  expect(appendImportRouteDeltas).not.toContain('recordChunk.reduce')
  expect(appendImportRouteDeltas).not.toContain('upsertReviewImportArticleHotField(tx')
  expect(appendImportRouteDeltas).not.toContain('appendReviewServingImportRunArticleDelta(tx')
})
