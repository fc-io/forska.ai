import {expect, test} from 'bun:test'

import {getRealCodexSeedArticles, loadAndValidateRealArticleFixtures} from '../realCodexSmoke.ts'
import {getRequestEvidenceFixture} from './getRequestEvidenceFixture.ts'

test('binds request evidence to the unique imported canonical ID while retaining pinned fixture content', async () => {
  const [article] = getRealCodexSeedArticles(await loadAndValidateRealArticleFixtures())
  if (!article) throw new Error('Expected a committed real Codex fixture')
  const id = crypto.randomUUID()
  const match = {id, articleId: article.fixtureId, articleTitle: article.title}

  expect(getRequestEvidenceFixture({data: [match, {id: 'other', articleTitle: 'Unrelated'}]}, article)).toEqual({
    abstract: article.abstract,
    articleId: id,
    fixtureId: article.fixtureId,
    fulltextSentinel: article.fulltextSentinel,
    imageSentinelUrl: article.imageSentinelUrl,
    title: article.title,
  })
  expect(() => {
    return getRequestEvidenceFixture({data: [match, {...match, id: 'duplicate'}]}, article)
  }).toThrow('Expected one canonical article identity')
  expect(() => {
    return getRequestEvidenceFixture({data: []}, article)
  }).toThrow('Expected one canonical article identity')
  expect(() => {
    return getRequestEvidenceFixture({data: {}}, article)
  }).toThrow('data was not an array')
})
