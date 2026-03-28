import {existsSync} from 'node:fs'
import path from 'node:path'

import {afterEach, expect, test} from 'bun:test'

import {
  buildCovidencePackageConfig,
  deleteCovidencePackageFiles,
  getCovidencePackageConfig,
  getCovidencePackageCursor,
  getCovidencePackageFileContent,
  parseCovidenceCsvReferenceRows,
  parseCovidenceReferenceRows,
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

test('parseCovidenceCsvReferenceRows keeps citation metadata and source file roles across Covidence csv lists', () => {
  const csvContent = [
    'Title,Authors,Abstract,Year,Tags,Notes,Reason for exclusion',
    'Study A,"Doe, Jane",A summary,2024,"tag one; tag two",Keep this,Wrong population',
  ].join('\n')

  const parsedRows = (['all', 'irrelevant', 'full_text', 'excluded', 'included'] as const).map((fileRole) => {
    return parseCovidenceCsvReferenceRows({
      content: csvContent,
      fileRole,
      format: 'csv',
      sourceFileName: `${fileRole}.csv`,
    })
  })

  expect(parsedRows).toEqual([
    {
      ok: true,
      rows: [
        {
          citation: {abstract: 'A summary', authors: 'Doe, Jane', title: 'Study A', year: '2024'},
          exclusionReason: 'Wrong population',
          fileRole: 'all',
          notes: 'Keep this',
          rowNumber: 2,
          sourceFileName: 'all.csv',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
    {
      ok: true,
      rows: [
        {
          citation: {abstract: 'A summary', authors: 'Doe, Jane', title: 'Study A', year: '2024'},
          exclusionReason: 'Wrong population',
          fileRole: 'irrelevant',
          notes: 'Keep this',
          rowNumber: 2,
          sourceFileName: 'irrelevant.csv',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
    {
      ok: true,
      rows: [
        {
          citation: {abstract: 'A summary', authors: 'Doe, Jane', title: 'Study A', year: '2024'},
          exclusionReason: 'Wrong population',
          fileRole: 'full_text',
          notes: 'Keep this',
          rowNumber: 2,
          sourceFileName: 'full_text.csv',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
    {
      ok: true,
      rows: [
        {
          citation: {abstract: 'A summary', authors: 'Doe, Jane', title: 'Study A', year: '2024'},
          exclusionReason: 'Wrong population',
          fileRole: 'excluded',
          notes: 'Keep this',
          rowNumber: 2,
          sourceFileName: 'excluded.csv',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
    {
      ok: true,
      rows: [
        {
          citation: {abstract: 'A summary', authors: 'Doe, Jane', title: 'Study A', year: '2024'},
          exclusionReason: 'Wrong population',
          fileRole: 'included',
          notes: 'Keep this',
          rowNumber: 2,
          sourceFileName: 'included.csv',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
  ])
})

test('parseCovidenceCsvReferenceRows returns stable parse errors for malformed or unsupported inputs', () => {
  expect(
    parseCovidenceCsvReferenceRows({
      content: 'TY  - JOUR\nER  - \n',
      fileRole: 'full_text',
      format: 'ris',
      sourceFileName: 'full_text.ris',
    }),
  ).toEqual({
    error: {
      code: 'unsupported_format',
      fileRole: 'full_text',
      message: "Covidence reference parsing only supports CSV inputs, got 'ris'",
      rowNumber: null,
      sourceFileName: 'full_text.ris',
    },
    ok: false,
  })

  expect(
    parseCovidenceCsvReferenceRows({
      content: 'Title,Authors\n"broken',
      fileRole: 'all',
      format: 'csv',
      sourceFileName: 'all.csv',
    }),
  ).toEqual({
    error: {
      code: 'malformed_csv',
      fileRole: 'all',
      message: 'Covidence CSV has an unclosed quoted field',
      rowNumber: null,
      sourceFileName: 'all.csv',
    },
    ok: false,
  })

  expect(
    parseCovidenceCsvReferenceRows({
      content: 'Title,Authors\nStudy A',
      fileRole: 'excluded',
      format: 'csv',
      sourceFileName: 'excluded.csv',
    }),
  ).toEqual({
    error: {
      code: 'row_length_mismatch',
      fileRole: 'excluded',
      message: 'Covidence CSV row 2 has 1 fields; expected 2',
      rowNumber: 2,
      sourceFileName: 'excluded.csv',
    },
    ok: false,
  })
})

test('parseCovidenceReferenceRows parses Covidence RIS rows into the same downstream shape across file roles', () => {
  const risContent = [
    'TY  - JOUR',
    'TI  - Study A',
    'AB  - A summary',
    'AU  - Doe, Jane',
    'AU  - Roe, John',
    'DO  - 10.1000/example',
    'PMID  - 123456',
    'UR  - https://example.com/study-a',
    'KW  - tag one',
    'KW  - tag two',
    'N1  - Keep this',
    'LB  - included_source',
    'ID  - covidence-1',
    'ER  - ',
  ].join('\n')

  const parsedRows = (['all', 'irrelevant', 'full_text', 'excluded', 'included'] as const).map((fileRole) => {
    return parseCovidenceReferenceRows({
      content: risContent,
      fileRole,
      format: 'ris',
      sourceFileName: `${fileRole}.ris`,
    })
  })

  expect(parsedRows).toEqual([
    {
      ok: true,
      rows: [
        {
          citation: {
            authors: 'Doe, Jane; Roe, John',
            doi: '10.1000/example',
            keywords: 'tag one; tag two',
            pmid: '123456',
            reference_id: 'covidence-1',
            reference_type: 'JOUR',
            source_role: 'included_source',
            title: 'Study A',
            abstract: 'A summary',
            url: 'https://example.com/study-a',
          },
          exclusionReason: null,
          fileRole: 'all',
          notes: 'Keep this',
          rowNumber: 1,
          sourceFileName: 'all.ris',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
    {
      ok: true,
      rows: [
        {
          citation: {
            authors: 'Doe, Jane; Roe, John',
            doi: '10.1000/example',
            keywords: 'tag one; tag two',
            pmid: '123456',
            reference_id: 'covidence-1',
            reference_type: 'JOUR',
            source_role: 'included_source',
            title: 'Study A',
            abstract: 'A summary',
            url: 'https://example.com/study-a',
          },
          exclusionReason: null,
          fileRole: 'irrelevant',
          notes: 'Keep this',
          rowNumber: 1,
          sourceFileName: 'irrelevant.ris',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
    {
      ok: true,
      rows: [
        {
          citation: {
            authors: 'Doe, Jane; Roe, John',
            doi: '10.1000/example',
            keywords: 'tag one; tag two',
            pmid: '123456',
            reference_id: 'covidence-1',
            reference_type: 'JOUR',
            source_role: 'included_source',
            title: 'Study A',
            abstract: 'A summary',
            url: 'https://example.com/study-a',
          },
          exclusionReason: null,
          fileRole: 'full_text',
          notes: 'Keep this',
          rowNumber: 1,
          sourceFileName: 'full_text.ris',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
    {
      ok: true,
      rows: [
        {
          citation: {
            authors: 'Doe, Jane; Roe, John',
            doi: '10.1000/example',
            keywords: 'tag one; tag two',
            pmid: '123456',
            reference_id: 'covidence-1',
            reference_type: 'JOUR',
            source_role: 'included_source',
            title: 'Study A',
            abstract: 'A summary',
            url: 'https://example.com/study-a',
          },
          exclusionReason: null,
          fileRole: 'excluded',
          notes: 'Keep this',
          rowNumber: 1,
          sourceFileName: 'excluded.ris',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
    {
      ok: true,
      rows: [
        {
          citation: {
            authors: 'Doe, Jane; Roe, John',
            doi: '10.1000/example',
            keywords: 'tag one; tag two',
            pmid: '123456',
            reference_id: 'covidence-1',
            reference_type: 'JOUR',
            source_role: 'included_source',
            title: 'Study A',
            abstract: 'A summary',
            url: 'https://example.com/study-a',
          },
          exclusionReason: null,
          fileRole: 'included',
          notes: 'Keep this',
          rowNumber: 1,
          sourceFileName: 'included.ris',
          tags: ['tag one', 'tag two'],
        },
      ],
    },
  ])
})

test('parseCovidenceReferenceRows returns stable RIS parse errors for malformed inputs', () => {
  expect(
    parseCovidenceReferenceRows({
      content: 'TY  - JOUR\nTI  - Broken\n',
      fileRole: 'full_text',
      format: 'ris',
      sourceFileName: 'full_text.ris',
    }),
  ).toEqual({
    error: {
      code: 'malformed_ris',
      fileRole: 'full_text',
      message: 'Covidence RIS is missing a terminating ER field',
      rowNumber: null,
      sourceFileName: 'full_text.ris',
    },
    ok: false,
  })

  expect(
    parseCovidenceReferenceRows({
      content: 'Not RIS\nER  - \n',
      fileRole: 'all',
      format: 'ris',
      sourceFileName: 'all.ris',
    }),
  ).toEqual({
    error: {
      code: 'malformed_ris',
      fileRole: 'all',
      message: 'Covidence RIS line 1 is not a valid RIS field',
      rowNumber: 1,
      sourceFileName: 'all.ris',
    },
    ok: false,
  })
})
