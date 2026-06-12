import {expect, test} from 'bun:test'

import {getProjectTransferExportAssetReferenceCollectionForArticles} from './projectTransferExportAssets.ts'

const getArticle = (fields: {
  fullTextAssets: unknown
  fullTextHtml: string | null
  fullTextPdf: string | null
  sourceArticleId: string
}) => {
  return {
    articleTitle: fields.sourceArticleId,
    fullTextAssets: fields.fullTextAssets,
    fullTextHtml: fields.fullTextHtml,
    fullTextPdf: fields.fullTextPdf,
    provenance: {sourceArticleId: fields.sourceArticleId},
    signature: {identifierKeys: [], title: fields.sourceArticleId},
    sourceArticleId: fields.sourceArticleId,
  } as Parameters<typeof getProjectTransferExportAssetReferenceCollectionForArticles>[0][number]
}

test('project-transfer export preserves signed non-local full-text URLs without warning annotations', () => {
  const signedUrl =
    'https://user:pass@example.test/full-text.pdf?X-Amz-Credential=abc%2F20260612&X-Amz-Signature=secret'
  const collection = getProjectTransferExportAssetReferenceCollectionForArticles([
    getArticle({
      fullTextAssets: {remote: signedUrl},
      fullTextHtml: `<a href="${signedUrl}">signed pdf</a>`,
      fullTextPdf: signedUrl,
      sourceArticleId: 'article-signed-non-local-url',
    }),
  ])

  expect(collection.references).toEqual([])
  expect(collection.articles[0]?.fullTextPdf).toBe(signedUrl)
  expect(collection.articles[0]?.fullTextHtml).toContain(signedUrl)
  expect(collection.articles[0]?.fullTextAssets).toEqual({remote: signedUrl})
  expect(collection.articles[0]?.warnings).toBeUndefined()
})
