import {expect, test} from 'bun:test'

import {loadAndValidateRealArticleFixtures} from '../realCodexSmoke.ts'
import {getSnapshotInputEvidence} from './getSnapshotInputEvidence.ts'

test('snapshot evidence maps canonical UUIDs to fixtures by the exact title and abstract', async () => {
  const fixtures = await loadAndValidateRealArticleFixtures()
  const [fixture] = fixtures
  if (!fixture) throw new Error('Expected a committed real Codex fixture')
  const article = {
    id: crypto.randomUUID(),
    articleId: 'unrelated-import-id',
    articleTitle: fixture.title,
    articleSummary: fixture.abstract,
    fullText: null,
    fullTextHtml: null,
    originalData: null,
  }

  expect(getSnapshotInputEvidence(article, fixtures)).toEqual({
    articleFixtureId: fixture.fixtureId,
    hasAbstract: true,
    hasExcludedContent: false,
    hasTitle: true,
  })
  expect(() => {
    return getSnapshotInputEvidence({...article, articleSummary: 'Different abstract'}, fixtures)
  }).toThrow('do not match')
  expect(() => {
    return getSnapshotInputEvidence({...article, originalData: {fullText: 'excluded'}}, fixtures)
  }).toThrow('excluded article content')
  expect(() => {
    return getSnapshotInputEvidence({...article, articleTitle: null}, fixtures)
  }).toThrow('omitted')
})
