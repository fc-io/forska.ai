import type {RealCodexSeedArticle} from '../realCodexSmoke.ts'

export const getRequestEvidenceFixture = (body: unknown, article: RealCodexSeedArticle) => {
  if (typeof body !== 'object' || body === null || !('data' in body) || !Array.isArray(body.data)) {
    throw new Error('Article search response data was not an array')
  }
  const matches = body.data.filter((value: unknown): value is Record<string, unknown> => {
    return (
      typeof value === 'object' && value !== null && 'articleTitle' in value && value.articleTitle === article.title
    )
  })
  const [match] = matches
  if (matches.length !== 1 || !match || typeof match.id !== 'string' || !match.id) {
    throw new Error(`Expected one canonical article identity for real Codex fixture ${article.fixtureId}`)
  }

  return {
    abstract: article.abstract,
    articleId: match.id,
    fixtureId: article.fixtureId,
    fulltextSentinel: article.fulltextSentinel,
    imageSentinelUrl: article.imageSentinelUrl,
    title: article.title,
  }
}
