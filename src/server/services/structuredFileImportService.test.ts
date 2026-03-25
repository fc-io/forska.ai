import {rmSync} from 'node:fs'
import path from 'node:path'

import {afterEach, expect, mock, test} from 'bun:test'

const articleImportStoreServiceModulePath = new URL('./articleImportStoreService.ts', import.meta.url).pathname

const storedRowsRef: {current: Array<Array<Record<string, unknown>>>} = {current: []}
const createdAssetPathsRef: {current: string[]} = {current: []}

void mock.module(articleImportStoreServiceModulePath, () => {
  return {
    storeImportedArticles: async (rows: Array<Record<string, unknown>>) => {
      storedRowsRef.current.push(rows)
    },
  }
})

const trackAssetPath = (assetPath: string) => {
  createdAssetPathsRef.current.push(path.resolve(process.cwd(), assetPath))
}

const getStoredRows = () => {
  return storedRowsRef.current.flatMap((batch) => {
    return batch
  })
}

afterEach(() => {
  storedRowsRef.current = []
  createdAssetPathsRef.current.forEach((assetPath) => {
    rmSync(assetPath, {force: true})
  })
  createdAssetPathsRef.current = []
})

test('analyzeStructuredFileUpload finds JSON array boundaries', async () => {
  const {analyzeStructuredFileUpload} = await import('./structuredFileImportService.ts')

  const result = await analyzeStructuredFileUpload(
    new File(
      [
        JSON.stringify({
          items: [
            {id: '1', title: 'Alpha'},
            {id: '2', title: 'Beta'},
          ],
          meta: {source: 'demo'},
        }),
      ],
      'records.json',
      {type: 'application/json'},
    ),
  )

  trackAssetPath(result.upload.assetPath)

  expect(result.upload.format).toBe('json')
  expect(result.candidates[0]).toMatchObject({count: 2, displayPath: '$.items[]', pointer: '/items'})
})

test('analyzeStructuredFileUpload finds XML repeated element boundaries', async () => {
  const {analyzeStructuredFileUpload} = await import('./structuredFileImportService.ts')

  const result = await analyzeStructuredFileUpload(
    new File(
      ['<root><record><id>1</id><title>Alpha</title></record><record><id>2</id><title>Beta</title></record></root>'],
      'records.xml',
      {type: 'application/xml'},
    ),
  )

  trackAssetPath(result.upload.assetPath)

  expect(result.upload.format).toBe('xml')
  expect(result.candidates[0]).toMatchObject({count: 2, displayPath: '$.root.record[]', pointer: '/root/record'})
})

test('importStructuredFileFromConfig builds article rows from selected boundary', async () => {
  const {analyzeStructuredFileUpload, buildStructuredFileImportConfig, importStructuredFileFromConfig} =
    await import('./structuredFileImportService.ts')

  const analysis = await analyzeStructuredFileUpload(
    new File(
      [
        JSON.stringify({
          records: [
            {
              id: 'item-1',
              title: 'Alpha title',
              summary: 'Alpha summary',
              author: 'Alice Example',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
            {
              id: 'item-2',
              title: 'Beta title',
              summary: 'Beta summary',
              author: 'Bob Example',
              createdAt: '2026-01-02T00:00:00.000Z',
            },
          ],
        }),
      ],
      'articles.json',
      {type: 'application/json'},
    ),
  )

  trackAssetPath(analysis.upload.assetPath)

  const result = await importStructuredFileFromConfig({
    config: buildStructuredFileImportConfig({
      assetPath: analysis.upload.assetPath,
      boundaryDisplayPath: '$.records[]',
      boundaryPointer: '/records',
      format: analysis.upload.format,
      sourceFileName: analysis.upload.sourceFileName,
    }),
    dataSourceTitle: 'Structured import',
    importRoute: 'structured-file:test-datasource',
  })

  expect(result.stats).toEqual({itemCount: 2, importedCount: 2})
  expect(getStoredRows()).toHaveLength(2)
  expect(getStoredRows()[0]).toMatchObject({
    articleAuthors: ['Alice Example'],
    articleId: 'structured-file:test-datasource:item-1',
    articleSummary: 'Alpha summary',
    articleTitle: 'Alpha title',
    fullTextConversionStatus: 'success',
    fullTextOriginalFormat: 'json',
    importRoute: 'structured-file:test-datasource',
  })
  expect(getStoredRows()[1]).toMatchObject({
    articleAuthors: ['Bob Example'],
    articleId: 'structured-file:test-datasource:item-2',
    articleSummary: 'Beta summary',
    articleTitle: 'Beta title',
  })
})
