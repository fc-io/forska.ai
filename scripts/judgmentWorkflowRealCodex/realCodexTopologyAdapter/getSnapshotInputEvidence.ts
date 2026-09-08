import {getRealArticleContentSha256, type RealArticleFixture} from '../realCodexSmoke.ts'

export const getSnapshotInputEvidence = (article: Record<string, unknown>, fixtures: RealArticleFixture[]) => {
  if (article.fullText !== null || article.fullTextHtml !== null || article.originalData !== null) {
    throw new Error('Execution snapshot retained excluded article content')
  }
  if (typeof article.articleTitle !== 'string' || typeof article.articleSummary !== 'string') {
    throw new Error('Execution snapshot omitted its title or abstract')
  }
  const hash = getRealArticleContentSha256({title: article.articleTitle, abstract: article.articleSummary})
  const fixture = fixtures.find(({contentSha256}) => {
    return contentSha256 === hash
  })
  if (!fixture) {
    throw new Error('Execution snapshot title and abstract do not match a real Codex fixture')
  }

  return {articleFixtureId: fixture.fixtureId, hasAbstract: true, hasExcludedContent: false, hasTitle: true}
}
