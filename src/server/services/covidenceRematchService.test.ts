import {expect, test} from 'bun:test'

import {type CovidenceRematchCandidateState, getCovidenceRematchPlan} from './covidenceRematchService.ts'

const emptyKeys = {covidenceIds: [], referenceIds: [], titleYearFirstAuthorHash: null}

const getState = (
  articleKey: string,
  currentArticleId: string | null,
  resolution: CovidenceRematchCandidateState['resolution'],
): CovidenceRematchCandidateState => {
  return {articleKey, currentArticleId, keys: emptyKeys, resolution, title: `Title ${articleKey}`}
}

test('getCovidenceRematchPlan remaps route-only duplicates whose records agree on one existing article', () => {
  const plan = getCovidenceRematchPlan({
    candidateStates: [
      getState('covidence:#1', 'dup-1', {articleId: 'base-1', matchTier: 'covidence_id', status: 'matched'}),
      getState('covidence:#2', 'dup-2', {articleId: 'base-2', matchTier: 'reference_id', status: 'matched'}),
      getState('covidence:#3', 'dup-2', {articleId: 'base-2', matchTier: 'title_year_first_author', status: 'matched'}),
      getState('covidence:#4', 'shared-1', {articleId: 'shared-1', matchTier: 'strong_identifier', status: 'matched'}),
      getState('covidence:#5', null, {articleId: 'base-5', matchTier: 'covidence_id', status: 'matched'}),
    ],
    routeOnlyArticleIds: new Set(['dup-1', 'dup-2']),
  })

  expect(plan.entries).toEqual([
    {articleKeys: ['covidence:#1'], duplicateArticleId: 'dup-1', matchTier: 'covidence_id', targetArticleId: 'base-1'},
    {
      articleKeys: ['covidence:#2', 'covidence:#3'],
      duplicateArticleId: 'dup-2',
      matchTier: 'reference_id',
      targetArticleId: 'base-2',
    },
  ])
  expect(plan.alreadySharedRecordCount).toBe(1)
  expect(plan.notImportedRecordCount).toBe(1)
  expect(plan.ambiguous).toEqual([])
  expect(plan.unmatchedRecordCount).toBe(0)
})

test('getCovidenceRematchPlan reports ambiguous matches, conflicting targets and shared targets without remapping', () => {
  const plan = getCovidenceRematchPlan({
    candidateStates: [
      getState('covidence:#1', 'dup-1', {
        articleIds: ['base-1', 'base-9'],
        matchTier: 'title_year_first_author',
        status: 'ambiguous',
      }),
      getState('covidence:#2', 'dup-2', {articleId: 'base-2', matchTier: 'covidence_id', status: 'matched'}),
      getState('covidence:#3', 'dup-2', {articleId: 'base-3', matchTier: 'covidence_id', status: 'matched'}),
      getState('covidence:#4', 'dup-4', {articleId: 'base-4', matchTier: 'covidence_id', status: 'matched'}),
      getState('covidence:#5', 'dup-5', {articleId: 'base-4', matchTier: 'covidence_id', status: 'matched'}),
      getState('covidence:#6', 'dup-6', {articleId: 'base-6', matchTier: 'covidence_id', status: 'matched'}),
      getState('covidence:#7', 'dup-6', {status: 'unmatched'}),
      getState('covidence:#8', 'dup-8', {status: 'unmatched'}),
    ],
    routeOnlyArticleIds: new Set(['dup-1', 'dup-2', 'dup-4', 'dup-5', 'dup-6', 'dup-8']),
  })

  expect(plan.entries).toEqual([])
  expect(
    plan.ambiguous.map((record) => {
      return [record.duplicateArticleId, record.reason, record.articleIds]
    }),
  ).toEqual([
    ['dup-1', 'ambiguous_match', ['base-1', 'base-9']],
    ['dup-2', 'conflicting_targets', ['base-2', 'base-3']],
    ['dup-6', 'conflicting_targets', ['base-6']],
    ['dup-4', 'shared_target', ['base-4']],
    ['dup-5', 'shared_target', ['base-4']],
  ])
  expect(plan.unmatchedRecordCount).toBe(1)
  expect(plan.unmatched).toEqual([
    {articleKey: 'covidence:#8', duplicateArticleId: 'dup-8', title: 'Title covidence:#8'},
  ])
})

test('getCovidenceRematchPlan is a no-op when no route-only article has a different match', () => {
  const plan = getCovidenceRematchPlan({
    candidateStates: [
      getState('covidence:#1', 'base-1', {articleId: 'base-1', matchTier: 'covidence_id', status: 'matched'}),
      getState('covidence:#2', 'only-2', {status: 'unmatched'}),
    ],
    routeOnlyArticleIds: new Set(['only-2']),
  })

  expect(plan.entries).toEqual([])
  expect(plan.ambiguous).toEqual([])
  expect(plan.alreadySharedRecordCount).toBe(1)
  expect(plan.unmatchedRecordCount).toBe(1)
})
