import {describe, expect, test} from 'bun:test'

import {SimplePdfDocument} from '../../utils/simplePdf.ts'
import {
  getComparisonProjectConflictResolutionTransferArtifactFromPdfImport,
  parsePdfConflictResolutionImport,
} from './comparisonProjectConflictResolutionPdfImport.ts'

const getMetadataValue = (value: unknown) => {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

const createFilledImportPdf = () => {
  const pdf = new SimplePdfDocument()

  pdf.addTextField({
    fieldName: 'forska.import.format',
    hidden: true,
    value: getMetadataValue({
      documentId: 'document-1',
      format: 'forska.comparisonProject.pdfConflictResolutionImport',
      version: 1,
    }),
  })
  pdf.addTextField({
    fieldName: 'forska.import.comparisonProject',
    hidden: true,
    value: getMetadataValue({
      allowConflictResolution: true,
      comparisonProjectId: 'comparison-project-1',
      comparisonProjectName: 'Source comparison',
      exportedAt: '2026-09-04T10:00:00.000Z',
      humanJudgmentMode: 'summary',
    }),
  })
  pdf.addTextField({
    fieldName: 'forska.reviewer.instance',
    hidden: true,
    value: getMetadataValue({reviewerInstanceId: 'reviewer-instance-1'}),
  })
  pdf.addTextField({fieldName: 'forska.reviewer.displayName', value: 'Dr Reviewer'})
  pdf.addTextField({fieldName: 'forska.reviewer.instanceId', value: 'reviewer-instance-visible'})
  pdf.addTextField({
    fieldName: 'comparison.comparison-project-1.article.article-1.metadata',
    hidden: true,
    value: getMetadataValue({
      articleExternalId: 'EXT-1',
      articleTitle: 'Article 1',
      canonicalArticleId: 'article-1',
      comparisonProjectId: 'comparison-project-1',
      hasConflict: true,
      identifiers: [
        {
          kind: 'doi',
          normalizedValue: '10.1000/example',
          source: 'article_identifier',
          sourceIdentifierId: 'identifier-1',
          isPrimary: true,
        },
      ],
    }),
  })
  pdf.addRadioRow('comparison.comparison-project-1.article.article-1.resolution', 'yes', [
    {label: 'Yes', value: 'yes'},
    {label: 'No', value: 'no'},
    {label: 'Maybe', value: 'maybe'},
  ])
  pdf.addRadioRow('comparison.comparison-project-1.article.article-2.resolution', undefined, [
    {label: 'Yes', value: 'yes'},
    {label: 'No', value: 'no'},
    {label: 'Maybe', value: 'maybe'},
  ])

  return pdf.toBuffer()
}

describe('comparison project conflict-resolution PDF import', () => {
  test('parses reviewer metadata and filled conflict-resolution radio fields', () => {
    const parsedImport = parsePdfConflictResolutionImport(createFilledImportPdf())

    expect(parsedImport.source).toEqual({
      comparisonProjectId: 'comparison-project-1',
      comparisonProjectName: 'Source comparison',
      exportedAt: '2026-09-04T10:00:00.000Z',
      formatVersion: 1,
      humanJudgmentMode: 'summary',
    })
    expect(parsedImport.reviewer).toEqual({displayName: 'Dr Reviewer', instanceId: 'reviewer-instance-visible'})
    expect(parsedImport.rows).toEqual([
      {
        fieldName: 'comparison.comparison-project-1.article.article-1.resolution',
        sourceArticleRowId: 'article-1',
        canonicalArticleId: 'article-1',
        externalArticleId: 'EXT-1',
        title: 'Article 1',
        identifiers: [
          {
            kind: 'doi',
            normalizedValue: '10.1000/example',
            source: 'article_identifier',
            sourceIdentifierId: 'identifier-1',
            isPrimary: true,
          },
        ],
        resolutionValue: 'yes',
      },
    ])
  })

  test('converts parsed PDF fields to the existing transfer artifact model', () => {
    const artifact = getComparisonProjectConflictResolutionTransferArtifactFromPdfImport(
      parsePdfConflictResolutionImport(createFilledImportPdf()),
    )

    expect(artifact).toMatchObject({
      format: 'forska.comparisonProject.conflictResolution.transfer',
      version: 1,
      exportedAt: '2026-09-04T10:00:00.000Z',
      source: {
        comparisonProjectId: 'comparison-project-1',
        comparisonProjectName: 'Source comparison',
        comparisonProjectDescription: 'PDF import reviewer: Dr Reviewer',
      },
      rows: [
        {
          sourceArticleRowId: 'article-1',
          externalArticleId: 'EXT-1',
          title: 'Article 1',
          resolution: {mode: 'summary', value: 'yes', label: 'Yes'},
        },
      ],
    })
  })

  test('supports old PDFs with only radio fields for same-project article-id matching', () => {
    const pdf = new SimplePdfDocument()

    pdf.addRadioRow('comparison.comparison-project-1.article.article-1.resolution', 'no', [
      {label: 'Yes', value: 'yes'},
      {label: 'No', value: 'no'},
      {label: 'Maybe', value: 'maybe'},
    ])

    const parsedImport = parsePdfConflictResolutionImport(pdf.toBuffer())
    const artifact = getComparisonProjectConflictResolutionTransferArtifactFromPdfImport({
      parsedImport,
      targetComparisonProjectId: 'comparison-project-1',
    })

    expect(parsedImport.warnings).toContain(
      'The selected PDF has no Forska import metadata; same-project article-id matching only is available.',
    )
    expect(parsedImport.source.comparisonProjectId).toBe('comparison-project-1')
    expect(artifact.rows).toEqual([
      {
        sourceResolutionId: 'comparison-project-1:article-1:pdf-resolution',
        sourceArticleRowId: 'article-1',
        externalArticleId: null,
        title: null,
        identifiers: [],
        resolution: {mode: 'summary', value: 'no', label: 'No'},
      },
    ])
  })

  test('rejects old PDFs without hidden row metadata for cross-project import', () => {
    const pdf = new SimplePdfDocument()

    pdf.addRadioRow('comparison.comparison-project-1.article.article-1.resolution', 'yes', [
      {label: 'Yes', value: 'yes'},
    ])

    const parsedImport = parsePdfConflictResolutionImport(pdf.toBuffer())

    expect(() => {
      getComparisonProjectConflictResolutionTransferArtifactFromPdfImport({
        parsedImport,
        targetComparisonProjectId: 'comparison-project-2',
      })
    }).toThrow('PDF has no hidden row metadata')
  })

  test('preserves prompt-mode PDF radio values for import-plan validation', () => {
    const pdf = new SimplePdfDocument()

    pdf.addTextField({
      fieldName: 'forska.import.comparisonProject',
      hidden: true,
      value: getMetadataValue({
        comparisonProjectId: 'comparison-project-1',
        comparisonProjectName: 'Prompt comparison',
        exportedAt: '2026-09-04T10:00:00.000Z',
        humanJudgmentMode: 'prompt',
      }),
    })
    pdf.addTextField({
      fieldName: 'comparison.comparison-project-1.article.article-1.metadata',
      hidden: true,
      value: getMetadataValue({articleTitle: 'Prompt article', canonicalArticleId: 'article-1'}),
    })
    pdf.addRadioRow('comparison.comparison-project-1.article.article-1.resolution', 'prompt-2', [
      {label: 'Prompt 1', value: 'prompt-1'},
      {label: 'Prompt 2', value: 'prompt-2'},
    ])

    const artifact = getComparisonProjectConflictResolutionTransferArtifactFromPdfImport(
      parsePdfConflictResolutionImport(pdf.toBuffer()),
    )

    expect(artifact.rows[0]?.resolution).toEqual({mode: 'prompt', value: 'prompt-2', label: 'Prompt-2'})
  })

  test('rejects malformed comparison field names', () => {
    const pdf = new SimplePdfDocument()

    pdf.addRadioRow('comparison.comparison-project-1.article.resolution', 'yes', [{label: 'Yes', value: 'yes'}])

    expect(() => {
      parsePdfConflictResolutionImport(pdf.toBuffer())
    }).toThrow('Malformed PDF comparison field name')
  })

  test('reports PDFs with no filled conflict-resolution fields', () => {
    const pdf = new SimplePdfDocument()

    pdf.addRadioRow('comparison.comparison-project-1.article.article-1.resolution', undefined, [
      {label: 'Yes', value: 'yes'},
    ])

    expect(() => {
      parsePdfConflictResolutionImport(pdf.toBuffer())
    }).toThrow('no filled conflict-resolution radio fields')
  })

  test('reports flattened PDFs with no form fields', () => {
    expect(() => {
      parsePdfConflictResolutionImport('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n')
    }).toThrow('no fillable form fields')
  })
})
