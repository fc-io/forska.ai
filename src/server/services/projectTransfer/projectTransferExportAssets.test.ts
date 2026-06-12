import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

import {
  getProjectTransferExportAssetCollectionForArticles,
  getProjectTransferExportAssetCollectionForReferences,
  getProjectTransferExportAssetReferenceCollectionForArticles,
} from './projectTransferExportAssets.ts'
import {getProjectTransferSha256Checksum} from './projectTransferFingerprint.ts'

const getRuntimeRoot = () => {
  return mkdtempSync(join(tmpdir(), `f2-project-transfer-export-assets-${process.pid}-`))
}

const writeRuntimeAsset = ({cwd, path, value}: {cwd: string; path: string; value: string}) => {
  const filePath = join(cwd, path)

  mkdirSync(dirname(filePath), {recursive: true})
  writeFileSync(filePath, value)

  return filePath
}

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
  } as Parameters<typeof getProjectTransferExportAssetCollectionForArticles>[0][number]
}

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

test('project-transfer export applies field-specific URL policy and copies runtime assets to staging', async () => {
  const cwd = getRuntimeRoot()
  const pdfPath = 'assets/project-transfer-export-assets/local.pdf'
  const figurePath = 'assets/project-transfer-export-assets/figure.png'
  const supplementPath = 'assets/project-transfer-export-assets/supplement.txt'
  const stagingRootPath = join(cwd, 'tmp/project-transfer/export-assets-stage')
  const signedUrl =
    'https://user:pass@example.test/full-text.pdf?X-Amz-Credential=abc%2F20260612&X-Amz-Signature=secret'
  const runtimeLookalikeUrl =
    'https://cdn.example.test/api/runtime-asset?path=assets/project-transfer-export-assets/private.pdf&X-Amz-Signature=secret'

  try {
    writeRuntimeAsset({cwd, path: pdfPath, value: 'pdf-content'})
    writeRuntimeAsset({cwd, path: figurePath, value: 'figure-content'})
    writeRuntimeAsset({cwd, path: supplementPath, value: 'supplement-content'})

    const collection = await getProjectTransferExportAssetCollectionForArticles(
      [
        getArticle({
          fullTextAssets: {remote: signedUrl, supplement: supplementPath},
          fullTextHtml: `<img src="/api/runtime-asset?path=${figurePath}"><a href="${runtimeLookalikeUrl}">remote</a>`,
          fullTextPdf: signedUrl,
          sourceArticleId: 'article-signed-url',
        }),
        getArticle({
          fullTextAssets: {plainRelative: 'source-system-id'},
          fullTextHtml: `<img src="${figurePath}">`,
          fullTextPdf: `/api/runtime-asset?path=${pdfPath}`,
          sourceArticleId: 'article-local-assets',
        }),
      ],
      {cwd, stagingRootPath},
    )
    const entryPaths = collection.assetEntries.map((entry) => {
      return entry.path
    })
    const referenceKinds = collection.assetManifest.entries.flatMap((entry) => {
      return entry.references.map((reference) => {
        return reference.kind
      })
    })

    expect(entryPaths).toEqual([figurePath, pdfPath, supplementPath])
    expect(collection.articles[0]?.fullTextPdf).toBe(signedUrl)
    expect(collection.articles[0]?.fullTextHtml).toContain(runtimeLookalikeUrl)
    expect(collection.articles[0]?.fullTextAssets).toEqual({remote: signedUrl, supplement: supplementPath})
    expect(collection.articles[1]?.fullTextPdf).toBe(pdfPath)
    expect(collection.articles[1]?.fullTextHtml).toContain(`src="${figurePath}"`)
    expect(referenceKinds).toEqual(['fullTextHtml', 'fullTextHtml', 'fullTextPdf', 'fullTextAssets'])
    expect(readFileSync(join(stagingRootPath, pdfPath), 'utf8')).toBe('pdf-content')
    expect(readFileSync(join(stagingRootPath, figurePath), 'utf8')).toBe('figure-content')
    expect(collection.assetManifest.entries[1]?.checksumSha256).toBe(
      getProjectTransferSha256Checksum(new TextEncoder().encode('pdf-content')),
    )
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})

test('project-transfer export preserves absolute runtime-asset lookalike URLs as non-local URLs', () => {
  const runtimeLookalikeUrl =
    'https://cdn.example.test/api/runtime-asset?path=assets/project-transfer-export-assets/private.pdf&X-Amz-Credential=abc'
  const collection = getProjectTransferExportAssetReferenceCollectionForArticles([
    getArticle({
      fullTextAssets: {remote: runtimeLookalikeUrl},
      fullTextHtml: `<img src="${runtimeLookalikeUrl}">`,
      fullTextPdf: runtimeLookalikeUrl,
      sourceArticleId: 'article-runtime-lookalike',
    }),
  ])

  expect(collection.references).toEqual([])
  expect(collection.articles[0]?.fullTextPdf).toBe(runtimeLookalikeUrl)
  expect(collection.articles[0]?.fullTextHtml).toContain(runtimeLookalikeUrl)
  expect(collection.articles[0]?.fullTextAssets).toEqual({remote: runtimeLookalikeUrl})
})

test('project-transfer export rejects symlinked runtime assets', async () => {
  const cwd = getRuntimeRoot()
  const targetPath = 'assets/project-transfer-export-assets/source.pdf'
  const symlinkPath = 'assets/project-transfer-export-assets/symlink.pdf'

  try {
    const targetFilePath = writeRuntimeAsset({cwd, path: targetPath, value: 'source-pdf'})
    const symlinkFilePath = join(cwd, symlinkPath)

    symlinkSync(targetFilePath, symlinkFilePath)

    const error = await getProjectTransferExportAssetCollectionForReferences(
      [
        {
          assetPath: symlinkPath,
          fieldPath: 'articles[0].fullTextPdf',
          jsonPointer: '/0/fullTextPdf',
          kind: 'fullTextPdf',
          sourceArticleId: 'article-symlink',
        },
      ],
      {cwd, stagingRootPath: join(cwd, 'tmp/project-transfer/export-assets-stage')},
    ).then(
      () => {
        return null
      },
      (caught: unknown) => {
        return caught
      },
    )

    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : String(error)).toContain('runtime asset is a symlink')
    expect(existsSync(targetFilePath)).toBe(true)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
})
