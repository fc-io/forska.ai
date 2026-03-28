import {existsSync} from 'node:fs'
import path from 'node:path'

import {afterEach, expect, test} from 'bun:test'

import {
  buildCovidencePackageConfig,
  deleteCovidencePackageFiles,
  getCovidencePackageConfig,
  getCovidencePackageCursor,
  getCovidencePackageFileContent,
  storeCovidencePackageFiles,
} from './covidenceImportService.ts'

const datasourceIdsToDelete = new Set<string>()

afterEach(() => {
  Array.from(datasourceIdsToDelete).map((datasourceId) => {
    deleteCovidencePackageFiles(datasourceId)
    return datasourceId
  })
  datasourceIdsToDelete.clear()
})

test('Covidence package config round-trips with one format for both modes', () => {
  const titleAbstractConfig = buildCovidencePackageConfig({
    files: [
      {
        assetPath: 'assets/covidence_imports/ds-1/all-all.csv',
        fileRole: 'all',
        format: 'csv',
        sourceFileName: 'all.csv',
      },
      {
        assetPath: 'assets/covidence_imports/ds-1/irrelevant-irrelevant.csv',
        fileRole: 'irrelevant',
        format: 'csv',
        sourceFileName: 'irrelevant.csv',
      },
      {
        assetPath: 'assets/covidence_imports/ds-1/full_text-full_text.ris',
        fileRole: 'full_text',
        format: 'ris',
        sourceFileName: 'full_text.ris',
      },
    ],
    mode: 'title_abstract',
  })
  const fullTextConfig = buildCovidencePackageConfig({
    files: [
      {
        assetPath: 'assets/covidence_imports/ds-2/all-all.csv',
        fileRole: 'all',
        format: 'csv',
        sourceFileName: 'all.csv',
      },
      {
        assetPath: 'assets/covidence_imports/ds-2/irrelevant-irrelevant.csv',
        fileRole: 'irrelevant',
        format: 'csv',
        sourceFileName: 'irrelevant.csv',
      },
      {
        assetPath: 'assets/covidence_imports/ds-2/full_text-full_text.ris',
        fileRole: 'full_text',
        format: 'ris',
        sourceFileName: 'full_text.ris',
      },
      {
        assetPath: 'assets/covidence_imports/ds-2/excluded-excluded.csv',
        fileRole: 'excluded',
        format: 'csv',
        sourceFileName: 'excluded.csv',
      },
      {
        assetPath: 'assets/covidence_imports/ds-2/included-included.csv',
        fileRole: 'included',
        format: 'csv',
        sourceFileName: 'included.csv',
      },
    ],
    mode: 'full_text',
  })

  expect(getCovidencePackageConfig(getCovidencePackageCursor(titleAbstractConfig))).toEqual(titleAbstractConfig)
  expect(getCovidencePackageConfig(getCovidencePackageCursor(fullTextConfig))).toEqual(fullTextConfig)
  expect(
    getCovidencePackageConfig(
      JSON.stringify({
        files: [
          {
            assetPath: 'assets/covidence_imports/ds-3/excluded.csv',
            fileRole: 'excluded',
            format: 'csv',
            sourceFileName: 'excluded.csv',
          },
        ],
        kind: 'covidence_import',
        mode: 'title_abstract',
        version: 1,
      }),
    ),
  ).toBeNull()
})

test('storeCovidencePackageFiles saves package files beneath the datasource folder and reads them back', async () => {
  const datasourceId = `covidence-test-${Date.now()}`
  datasourceIdsToDelete.add(datasourceId)
  const storedFiles = await storeCovidencePackageFiles({
    datasourceId,
    files: [
      {file: new File(['alpha,beta\n1,2\n'], 'all references.csv', {type: 'text/csv'}), fileRole: 'all'},
      {
        file: new File(['TY  - JOUR\nTI  - Example\nER  - \n'], 'full text.ris', {
          type: 'application/x-research-info-systems',
        }),
        fileRole: 'full_text',
      },
      {file: new File(['alpha,beta\n3,4\n'], 'irrelevant.csv', {type: 'text/csv'}), fileRole: 'irrelevant'},
    ],
  })

  expect(storedFiles).toHaveLength(3)
  expect(
    storedFiles.map((file) => {
      return file.assetPath
    }),
  ).toEqual([
    `assets/covidence_imports/${datasourceId}/all-all-references.csv`,
    `assets/covidence_imports/${datasourceId}/full_text-full-text.ris`,
    `assets/covidence_imports/${datasourceId}/irrelevant-irrelevant.csv`,
  ])
  expect(
    storedFiles.map((file) => {
      return file.format
    }),
  ).toEqual(['csv', 'ris', 'csv'])
  const firstStoredFile = storedFiles[0]
  const secondStoredFile = storedFiles[1]

  if (!firstStoredFile || !secondStoredFile) {
    throw new Error('Expected stored Covidence files')
  }

  expect(getCovidencePackageFileContent(firstStoredFile.assetPath)).toContain('alpha,beta')
  expect(getCovidencePackageFileContent(secondStoredFile.assetPath)).toContain('TY  - JOUR')
  expect(() => {
    getCovidencePackageFileContent(`assets/covidence_imports/${datasourceId}/../escape.csv`)
  }).toThrow('Invalid Covidence package asset path')
})

test('deleteCovidencePackageFiles removes the datasource package folder', async () => {
  const datasourceId = `covidence-test-delete-${Date.now()}`
  const storedFiles = await storeCovidencePackageFiles({
    datasourceId,
    files: [
      {file: new File(['alpha,beta\n1,2\n'], 'all.csv', {type: 'text/csv'}), fileRole: 'all'},
      {file: new File(['alpha,beta\n3,4\n'], 'irrelevant.csv', {type: 'text/csv'}), fileRole: 'irrelevant'},
      {
        file: new File(['TY  - JOUR\nTI  - Example\nER  - \n'], 'full_text.ris', {
          type: 'application/x-research-info-systems',
        }),
        fileRole: 'full_text',
      },
    ],
  })

  deleteCovidencePackageFiles(datasourceId)

  const firstStoredFile = storedFiles[0]

  if (!firstStoredFile) {
    throw new Error('Expected stored Covidence file')
  }

  expect(existsSync(path.resolve(process.cwd(), firstStoredFile.assetPath))).toBe(false)
})
