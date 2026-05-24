import {expect, test} from 'bun:test'

import {getProjectTransferExportAssetCollectionForArticles} from './projectTransferExportAssets.ts'

test('project-transfer export leaves non-asset full-text HTML links untouched', async () => {
  const fullTextHtml =
    '<p><a href="https://doi.org/10.1000/example">DOI</a><img src="https://example.com/image.png"></p>'
  const collection = await getProjectTransferExportAssetCollectionForArticles([
    {fullTextAssets: null, fullTextHtml, fullTextPdf: null, sourceArticleId: 'article-external-link'},
  ] as Parameters<typeof getProjectTransferExportAssetCollectionForArticles>[0])

  expect(collection.assetEntries).toHaveLength(0)
  expect(collection.assetManifest.entries).toHaveLength(0)
  expect(collection.articles[0]?.fullTextHtml).toBe(fullTextHtml)
})
