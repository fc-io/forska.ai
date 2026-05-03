import {mkdirSync, readdirSync, rmSync} from 'node:fs'
import path from 'node:path'

import {afterEach, expect, mock, test} from 'bun:test'

const articleImportStoreServiceModulePath = new URL('./articleImportStoreService.ts', import.meta.url).pathname

type StructuredFileImportServiceModule = typeof import('./structuredFileImportService.ts')

const storedRowsRef: {current: Array<Array<Record<string, unknown>>>} = {current: []}
const createdAssetPathsRef: {current: string[]} = {current: []}

void mock.module(articleImportStoreServiceModulePath, () => {
  return {
    markImportedArticleProjectsDirty: async (_importRouteIds: string[]) => {},
    storeImportedArticles: async (rows: Array<Record<string, unknown>>) => {
      storedRowsRef.current.push(rows)
    },
    storeImportedArticlesWithTx: async (_tx: unknown, rows: Array<Record<string, unknown>>) => {
      storedRowsRef.current.push(rows)
      return {importRouteIds: []}
    },
  }
})

const trackAssetPath = (assetPath: string) => {
  createdAssetPathsRef.current.push(path.resolve(process.cwd(), assetPath))
}

const structuredFileImportDirectory = path.resolve(process.cwd(), 'assets/structured_file_imports')

const getMatchingStructuredImportFiles = (suffix: string) => {
  mkdirSync(structuredFileImportDirectory, {recursive: true})

  return readdirSync(structuredFileImportDirectory).filter((fileName) => {
    return fileName.endsWith(suffix)
  })
}

const removeMatchingStructuredImportFiles = (suffix: string) => {
  getMatchingStructuredImportFiles(suffix).forEach((fileName) => {
    rmSync(path.join(structuredFileImportDirectory, fileName), {force: true})
  })
}

const getStoredRows = () => {
  return storedRowsRef.current.flatMap((batch) => {
    return batch
  })
}

const loadStructuredFileImportService = async (): Promise<StructuredFileImportServiceModule> => {
  const moduleUnknown: unknown = await import(`./structuredFileImportService.ts?test=${Date.now()}-${Math.random()}`)
  return moduleUnknown as StructuredFileImportServiceModule
}

afterEach(() => {
  storedRowsRef.current = []
  createdAssetPathsRef.current.forEach((assetPath) => {
    rmSync(assetPath, {force: true})
  })
  createdAssetPathsRef.current = []
})

test('analyzeStructuredFileUpload finds JSON array boundaries', async () => {
  const {analyzeStructuredFileUpload} = await loadStructuredFileImportService()

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
  expect(result.candidates[0]?.samplePreview).toBe(`{
  "id": "1",
  "title": "Alpha"
}`)
})

test('analyzeStructuredFileUpload finds XML repeated element boundaries', async () => {
  const {analyzeStructuredFileUpload} = await loadStructuredFileImportService()

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

test('analyzeStructuredFileUpload only returns root-resolvable boundary paths', async () => {
  const {analyzeStructuredFileUpload} = await loadStructuredFileImportService()

  const result = await analyzeStructuredFileUpload(
    new File(
      [JSON.stringify([{records: [{id: '1'}, {id: '2'}]}, {records: [{id: '3'}, {id: '4'}]}])],
      'nested-records.json',
      {type: 'application/json'},
    ),
  )

  trackAssetPath(result.upload.assetPath)

  expect(
    result.candidates.map((candidate) => {
      return candidate.pointer
    }),
  ).toEqual([''])
  expect(result.candidates[0]).toMatchObject({count: 2, displayPath: '$[]', pointer: ''})
})

test('analyzeStructuredFileUpload deletes staged uploads when parsing fails', async () => {
  const {analyzeStructuredFileUpload} = await loadStructuredFileImportService()
  const fileNameSuffix = 'invalid-structured-upload.json'

  removeMatchingStructuredImportFiles(fileNameSuffix)

  let error: Error | null = null

  try {
    await analyzeStructuredFileUpload(new File(['{"records": ['], fileNameSuffix, {type: 'application/json'}))
  } catch (caughtError) {
    error = caughtError instanceof Error ? caughtError : new Error(String(caughtError))
  }

  expect(error).toBeInstanceOf(Error)
  expect(getMatchingStructuredImportFiles(fileNameSuffix)).toHaveLength(0)
})

test('analyzeStructuredFileUpload deletes staged uploads when no repeating boundary is found', async () => {
  const {analyzeStructuredFileUpload} = await loadStructuredFileImportService()
  const fileNameSuffix = 'no-boundary-upload.json'

  removeMatchingStructuredImportFiles(fileNameSuffix)

  let error: Error | null = null

  try {
    await analyzeStructuredFileUpload(
      new File([JSON.stringify({record: {id: '1'}})], fileNameSuffix, {type: 'application/json'}),
    )
  } catch (caughtError) {
    error = caughtError instanceof Error ? caughtError : new Error(String(caughtError))
  }

  expect(error?.message).toBe('No repeating boundary found in file')
  expect(getMatchingStructuredImportFiles(fileNameSuffix)).toHaveLength(0)
})

test('importStructuredFileFromConfig builds article rows from selected boundary', async () => {
  const {analyzeStructuredFileUpload, buildStructuredFileImportConfig, importStructuredFileFromConfig} =
    await loadStructuredFileImportService()

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
    importRoute: 'imported-file:test-datasource',
  })

  expect(result.stats).toEqual({itemCount: 2, importedCount: 2})
  expect(getStoredRows()).toHaveLength(2)
  expect(getStoredRows()[0]).toMatchObject({
    articleAuthors: ['Alice Example'],
    articleId: 'imported-file:test-datasource:item-1',
    articleSummary: 'Alpha summary',
    articleTitle: 'Alpha title',
    fullTextConversionStatus: 'success',
    fullTextOriginalFormat: 'json',
    importRoute: 'imported-file:test-datasource',
  })
  expect(getStoredRows()[1]).toMatchObject({
    articleAuthors: ['Bob Example'],
    articleId: 'imported-file:test-datasource:item-2',
    articleSummary: 'Beta summary',
    articleTitle: 'Beta title',
  })
})

test('importStructuredFileFromConfig keeps long explicit ids distinct', async () => {
  const {analyzeStructuredFileUpload, buildStructuredFileImportConfig, importStructuredFileFromConfig} =
    await loadStructuredFileImportService()
  const sharedPrefix = 'long-id-'.repeat(30)
  const analysis = await analyzeStructuredFileUpload(
    new File(
      [
        JSON.stringify({
          records: [
            {id: `${sharedPrefix}alpha`, title: 'Alpha title'},
            {id: `${sharedPrefix}beta`, title: 'Beta title'},
          ],
        }),
      ],
      'long-ids.json',
      {type: 'application/json'},
    ),
  )

  trackAssetPath(analysis.upload.assetPath)

  await importStructuredFileFromConfig({
    config: buildStructuredFileImportConfig({
      assetPath: analysis.upload.assetPath,
      boundaryDisplayPath: '$.records[]',
      boundaryPointer: '/records',
      format: analysis.upload.format,
      sourceFileName: analysis.upload.sourceFileName,
    }),
    dataSourceTitle: 'Structured import',
    importRoute: 'imported-file:test-datasource',
  })

  const storedRows = getStoredRows()

  expect(storedRows).toHaveLength(2)
  expect(storedRows[0]?.articleId).not.toBe(storedRows[1]?.articleId)
  expect(storedRows[0]?.articleId).toMatch(/^imported-file:test-datasource:/)
  expect(storedRows[1]?.articleId).toMatch(/^imported-file:test-datasource:/)
})
