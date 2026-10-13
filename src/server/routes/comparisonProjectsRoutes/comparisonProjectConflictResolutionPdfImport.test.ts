import {describe, expect, test} from 'bun:test'

import {SimplePdfDocument} from '../../utils/simplePdf.ts'
import {
  getComparisonProjectConflictResolutionTransferArtifactFromPdfImport,
  getParsedPdfConflictResolutionImportArticleCount,
  parsePdfConflictResolutionImport,
  pdfConflictResolutionNotSetValue,
} from './comparisonProjectConflictResolutionPdfImport.ts'

const getMetadataValue = (value: unknown) => {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

const judgmentContextId = '2168ca3cc7e7cb3c3fa173f7aeeff04314ed31e83a9b2b201695446a6461922a'

const createFilledImportPdf = (projectMetadata: Record<string, unknown> = {}) => {
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
      ...projectMetadata,
    }),
  })
  pdf.addTextField({fieldName: 'forska.reviewer.displayName', value: 'Dr Reviewer'})
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
  test('reads the exported judgment context id from the project metadata and ignores malformed ids', () => {
    expect(parsePdfConflictResolutionImport(createFilledImportPdf({judgmentContextId})).source.judgmentContextId).toBe(
      judgmentContextId,
    )
    expect(
      parsePdfConflictResolutionImport(createFilledImportPdf({judgmentContextId: 'not-a-context-id'})).source
        .judgmentContextId,
    ).toBeNull()
    expect(
      parsePdfConflictResolutionImport(createFilledImportPdf({judgmentContextId: judgmentContextId.toUpperCase()}))
        .source.judgmentContextId,
    ).toBeNull()
  })

  test('parses reviewer name and filled conflict-resolution radio fields', () => {
    const parsedImport = parsePdfConflictResolutionImport(createFilledImportPdf())

    expect(parsedImport.source).toEqual({
      comparisonProjectId: 'comparison-project-1',
      comparisonProjectName: 'Source comparison',
      exportedAt: '2026-09-04T10:00:00.000Z',
      formatVersion: 1,
      humanJudgmentMode: 'summary',
      judgmentContextId: null,
    })
    expect(parsedImport.reviewer).toEqual({displayName: 'Dr Reviewer', instanceId: null})
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
        comment: null,
      },
    ])
  })

  test('parses compact PDF dictionaries rewritten by PDF editors', () => {
    const metadata = getMetadataValue({
      articleExternalId: 'EXT-1',
      articleTitle: 'Article 1',
      canonicalArticleId: 'article-1',
      comparisonProjectId: 'comparison-project-1',
      hasConflict: true,
    })
    const pdfSource = `%PDF-1.4
1 0 obj
<</FT/Btn/Ff 49152/Kids[ 2 0 R 3 0 R ]/T(comparison.comparison-project-1.article.article-1.resolution)/V/no>>
endobj
2 0 obj
<</AP<</N<</Off 4 0 R /yes 5 0 R>>>>/AS/Off/Parent 1 0 R/Subtype/Widget/Type/Annot>>
endobj
3 0 obj
<</AP<</N<</Off 4 0 R /no 5 0 R>>>>/AS/no/Parent 1 0 R/Subtype/Widget/Type/Annot>>
endobj
4 0 obj
<</FT/Tx/T(forska.reviewer.displayName)/V(Dr Reviewer)>>
endobj
5 0 obj
<</FT/Tx/T(comparison.comparison-project-1.article.article-1.metadata)/V(${metadata})>>
endobj`

    const parsedImport = parsePdfConflictResolutionImport(pdfSource)

    expect(parsedImport.reviewer).toEqual({displayName: 'Dr Reviewer', instanceId: null})
    expect(parsedImport.rows).toMatchObject([
      {
        fieldName: 'comparison.comparison-project-1.article.article-1.resolution',
        canonicalArticleId: 'article-1',
        externalArticleId: 'EXT-1',
        resolutionValue: 'no',
        title: 'Article 1',
      },
    ])
  })

  test('ignores legacy reviewer IDs from PDF fields and metadata', () => {
    const pdf = new SimplePdfDocument()

    pdf.addTextField({fieldName: 'forska.reviewer.displayName', value: 'Dr Reviewer'})
    pdf.addTextField({fieldName: 'forska.reviewer.instanceId', value: 'legacy-visible-id'})
    pdf.addTextField({
      fieldName: 'forska.reviewer.instance',
      hidden: true,
      value: getMetadataValue({reviewerInstanceId: 'legacy-hidden-id'}),
    })
    pdf.addRadioRow('comparison.comparison-project-1.article.article-1.resolution', 'yes', [
      {label: 'Yes', value: 'yes'},
      {label: 'No', value: 'no'},
    ])

    const parsedImport = parsePdfConflictResolutionImport(pdf.toBuffer())

    expect(parsedImport.reviewer).toEqual({displayName: 'Dr Reviewer', instanceId: null})
  })

  test('tracks the explicit PDF undecided radio choice separately from imported resolutions', () => {
    const pdf = new SimplePdfDocument()

    pdf.addRadioRow('comparison.comparison-project-1.article.article-1.resolution', pdfConflictResolutionNotSetValue, [
      {label: 'Not set', value: pdfConflictResolutionNotSetValue},
      {label: 'Yes', value: 'yes'},
    ])
    pdf.addRadioRow('comparison.comparison-project-1.article.article-2.resolution', 'yes', [
      {label: 'Not set', value: pdfConflictResolutionNotSetValue},
      {label: 'Yes', value: 'yes'},
    ])

    const parsedImport = parsePdfConflictResolutionImport(pdf.toBuffer())

    expect(parsedImport.rows).toEqual([
      {
        fieldName: 'comparison.comparison-project-1.article.article-2.resolution',
        sourceArticleRowId: 'article-2',
        canonicalArticleId: 'article-2',
        externalArticleId: null,
        title: null,
        identifiers: [],
        resolutionValue: 'yes',
        comment: null,
      },
    ])
    expect(parsedImport.undecidedRows).toEqual([
      {
        fieldName: 'comparison.comparison-project-1.article.article-1.resolution',
        sourceArticleRowId: 'article-1',
        canonicalArticleId: 'article-1',
        externalArticleId: null,
        title: null,
        identifiers: [],
        resolutionValue: pdfConflictResolutionNotSetValue,
      },
    ])
  })

  test('accepts PDFs where every conflict-resolution radio field is explicitly undecided', () => {
    const pdf = new SimplePdfDocument()

    pdf.addRadioRow('comparison.comparison-project-1.article.article-1.resolution', pdfConflictResolutionNotSetValue, [
      {label: 'Not set', value: pdfConflictResolutionNotSetValue},
      {label: 'Yes', value: 'yes'},
    ])

    expect(parsePdfConflictResolutionImport(pdf.toBuffer()).undecidedRows).toMatchObject([
      {
        fieldName: 'comparison.comparison-project-1.article.article-1.resolution',
        resolutionValue: pdfConflictResolutionNotSetValue,
      },
    ])
  })

  test('converts parsed PDF fields to the existing transfer artifact model', () => {
    const artifact = getComparisonProjectConflictResolutionTransferArtifactFromPdfImport(
      parsePdfConflictResolutionImport(createFilledImportPdf()),
    )

    expect(artifact).toMatchObject({
      format: 'forska.comparisonProject.conflictResolution.transfer',
      version: 3,
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
        comment: null,
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

type CommentReviewArticle = {
  articleId: string
  exportedComment: string | null
  radio?: string | null
  value?: string
  withMetadata?: boolean
}

const getCommentFieldName = (articleId: string) => {
  return `comparison.comparison-project-1.article.${articleId}.comment`
}

const createCommentReviewPdf = (articles: CommentReviewArticle[], withProjectMetadata = true) => {
  const pdf = new SimplePdfDocument()

  if (withProjectMetadata) {
    pdf.addTextField({
      fieldName: 'forska.import.format',
      hidden: true,
      value: getMetadataValue({format: 'forska.comparisonProject.pdfConflictResolutionImport', version: 1}),
    })
    pdf.addTextField({
      fieldName: 'forska.import.comparisonProject',
      hidden: true,
      value: getMetadataValue({
        allowConflictResolution: true,
        comparisonProjectId: 'comparison-project-1',
        comparisonProjectName: 'Source comparison',
        exportedAt: '2026-10-13T10:00:00.000Z',
        humanJudgmentMode: 'summary',
      }),
    })
  }

  pdf.addTextField({fieldName: 'forska.reviewer.displayName', value: 'Dr Reviewer'})
  articles.forEach((article) => {
    if (article.withMetadata !== false) {
      pdf.addTextField({
        fieldName: `comparison.comparison-project-1.article.${article.articleId}.metadata`,
        hidden: true,
        value: getMetadataValue({
          articleExternalId: `EXT-${article.articleId}`,
          articleTitle: `Title ${article.articleId}`,
          canonicalArticleId: article.articleId,
          comparisonProjectId: 'comparison-project-1',
          exportedComment: article.exportedComment,
          hasConflict: true,
        }),
      })
    }

    if (article.radio !== undefined) {
      pdf.addRadioRow(`comparison.comparison-project-1.article.${article.articleId}.resolution`, article.radio, [
        {label: 'Undecided', value: pdfConflictResolutionNotSetValue},
        {label: 'Yes', value: 'yes'},
        {label: 'No', value: 'no'},
      ])
    }

    pdf.addTextField({
      fieldName: getCommentFieldName(article.articleId),
      label: 'Comment (optional)',
      lines: 4,
      maxLength: 4000,
      multiline: true,
      value: article.value ?? article.exportedComment ?? '',
    })
  })

  return pdf.toBuffer()
}

const getEscapedRegExpText = (value: string) => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const appendViewerFieldUpdates = (pdfBuffer: Buffer, updates: Array<{fieldName: string; valueToken: string}>) => {
  const source = pdfBuffer.toString('latin1')
  const previousXrefOffset = /startxref\n(\d+)\n%%EOF\n$/.exec(source)?.[1] ?? '0'
  const size = /\/Size (\d+)/.exec(source)?.[1] ?? '0'
  const objects = updates.map((update) => {
    const objectNumber =
      new RegExp(
        `(\\d+) 0 obj\\n<< /Type /Annot /Subtype /Widget /FT /Tx /T \\(${getEscapedRegExpText(update.fieldName)}\\)`,
      ).exec(source)?.[1] ?? '0'

    return {
      body: `${objectNumber} 0 obj\n<</DA(/F1 10 Tf 0 0 0 rg)/F 4/FT/Tx/Ff 4096/MaxLen 4000/T(${update.fieldName})/Type/Annot/Subtype/Widget/V${update.valueToken}>>\nendobj\n`,
      objectNumber,
    }
  })
  const chunks = objects.reduce<{offset: number; text: string; xref: string[]}>(
    (state, object) => {
      return {
        offset: state.offset + Buffer.byteLength(object.body, 'latin1'),
        text: `${state.text}${object.body}`,
        xref: [...state.xref, `${object.objectNumber} 1\n${String(state.offset).padStart(10, '0')} 00000 n \n`],
      }
    },
    {offset: pdfBuffer.length, text: '', xref: []},
  )
  const trailer = `xref\n${chunks.xref.join('')}trailer\n<< /Size ${size} /Root 1 0 R /Prev ${previousXrefOffset} >>\nstartxref\n${chunks.offset}\n%%EOF\n`

  return Buffer.concat([pdfBuffer, Buffer.from(`${chunks.text}${trailer}`, 'latin1')])
}

const getUtf16BeHexToken = (value: string) => {
  return `<FE FF ${Buffer.from(value, 'utf16le')
    .swap16()
    .toString('hex')
    .toUpperCase()
    .replace(/(.{4})/g, '$1 ')}>`
}

describe('comparison project conflict-resolution PDF import comments', () => {
  test('decodes literal comment values with octal escapes, nested parentheses and line continuations', () => {
    const pdf = appendViewerFieldUpdates(createCommentReviewPdf([{articleId: 'article-1', exportedComment: null}]), [
      {
        fieldName: getCommentFieldName('article-1'),
        valueToken: '(Vuxna \\344r oklart (18+)? Se \\(protokoll\\) \\\nfortsatt\\tslut\\101)',
      },
    ])

    expect(parsePdfConflictResolutionImport(pdf).commentOnlyRows).toMatchObject([
      {comment: 'Vuxna är oklart (18+)? Se (protokoll) fortsatt\tslutA'},
    ])
  })

  test('decodes UTF-16BE hex and literal values, UTF-8 BOM values and normalises CR and CRLF line breaks', () => {
    const pdf = appendViewerFieldUpdates(
      createCommentReviewPdf([
        {articleId: 'article-1', exportedComment: null},
        {articleId: 'article-2', exportedComment: null},
        {articleId: 'article-3', exportedComment: null},
        {articleId: 'article-4', exportedComment: null},
      ]),
      [
        {fieldName: getCommentFieldName('article-1'), valueToken: getUtf16BeHexToken('Skär\r\nrad två \u{1F44D}')},
        {
          fieldName: getCommentFieldName('article-2'),
          valueToken: `(þÿ${Buffer.from('Åsa\rOk', 'utf16le')
            .swap16()
            .toString('latin1')
            .replace(/[\\()]/g, '\\$&')
            .replace(/\r/g, '\\r')})`,
        },
        {fieldName: getCommentFieldName('article-3'), valueToken: '<EFBBBF 536BC3A472>'},
        {fieldName: getCommentFieldName('article-4'), valueToken: '(line one\r\nline two\\rline three\rline four)'},
      ],
    )

    expect(
      parsePdfConflictResolutionImport(pdf).commentOnlyRows.map((row) => {
        return [row.canonicalArticleId, row.comment]
      }),
    ).toEqual([
      ['article-1', 'Skär\nrad två \u{1F44D}'],
      ['article-2', 'Åsa\nOk'],
      ['article-3', 'Skär'],
      ['article-4', 'line one\nline two\nline three\nline four'],
    ])
  })

  test('ignores untouched prefilled comments, also when a viewer rewrote the line breaks', () => {
    const pdf = appendViewerFieldUpdates(
      createCommentReviewPdf([
        {articleId: 'article-1', exportedComment: 'Existing note', radio: 'yes'},
        {articleId: 'article-2', exportedComment: 'Line one\r\nline two å', radio: null},
      ]),
      [{fieldName: getCommentFieldName('article-2'), valueToken: getUtf16BeHexToken('Line one\rline two å  ')}],
    )
    const parsedImport = parsePdfConflictResolutionImport(pdf)

    expect(parsedImport.rows).toMatchObject([{canonicalArticleId: 'article-1', comment: null, resolutionValue: 'yes'}])
    expect(parsedImport.commentOnlyRows).toEqual([])
    expect(() => {
      parsePdfConflictResolutionImport(
        createCommentReviewPdf([{articleId: 'article-1', exportedComment: 'Existing note', radio: null}]),
      )
    }).toThrow('The selected PDF has no filled conflict-resolution radio fields and no changed comments.')
  })

  test('brings an edited comment on a decided row and comment-only rows for unset and undecided radios', () => {
    const pdf = appendViewerFieldUpdates(
      createCommentReviewPdf([
        {articleId: 'article-1', exportedComment: 'Old note', radio: 'no'},
        {articleId: 'article-2', exportedComment: null, radio: null},
        {articleId: 'article-3', exportedComment: 'Kept', radio: pdfConflictResolutionNotSetValue},
        {articleId: 'article-4', exportedComment: null},
      ]),
      [
        {fieldName: getCommentFieldName('article-1'), valueToken: '(New note)'},
        {fieldName: getCommentFieldName('article-2'), valueToken: '(Unset radio note)'},
        {fieldName: getCommentFieldName('article-3'), valueToken: '(Undecided note)'},
        {fieldName: getCommentFieldName('article-4'), valueToken: '(  Radio-less note  )'},
      ],
    )
    const parsedImport = parsePdfConflictResolutionImport(pdf)

    expect(parsedImport.rows).toEqual([
      {
        fieldName: 'comparison.comparison-project-1.article.article-1.resolution',
        sourceArticleRowId: 'article-1',
        canonicalArticleId: 'article-1',
        externalArticleId: 'EXT-article-1',
        title: 'Title article-1',
        identifiers: [],
        resolutionValue: 'no',
        comment: 'New note',
      },
    ])
    expect(parsedImport.undecidedRows).toEqual([
      {
        fieldName: 'comparison.comparison-project-1.article.article-3.resolution',
        sourceArticleRowId: 'article-3',
        canonicalArticleId: 'article-3',
        externalArticleId: 'EXT-article-3',
        title: 'Title article-3',
        identifiers: [],
        resolutionValue: pdfConflictResolutionNotSetValue,
      },
    ])
    expect(parsedImport.commentOnlyRows).toEqual([
      {
        fieldName: getCommentFieldName('article-2'),
        sourceArticleRowId: 'article-2',
        canonicalArticleId: 'article-2',
        externalArticleId: 'EXT-article-2',
        title: 'Title article-2',
        identifiers: [],
        resolutionValue: null,
        comment: 'Unset radio note',
      },
      {
        fieldName: getCommentFieldName('article-3'),
        sourceArticleRowId: 'article-3',
        canonicalArticleId: 'article-3',
        externalArticleId: 'EXT-article-3',
        title: 'Title article-3',
        identifiers: [],
        resolutionValue: null,
        comment: 'Undecided note',
      },
      {
        fieldName: getCommentFieldName('article-4'),
        sourceArticleRowId: 'article-4',
        canonicalArticleId: 'article-4',
        externalArticleId: 'EXT-article-4',
        title: 'Title article-4',
        identifiers: [],
        resolutionValue: null,
        comment: 'Radio-less note',
      },
    ])
  })

  test('a cleared or control-character-only comment brings nothing', () => {
    const pdf = appendViewerFieldUpdates(
      createCommentReviewPdf([
        {articleId: 'article-1', exportedComment: 'Old note', radio: 'yes'},
        {articleId: 'article-2', exportedComment: 'Other note', radio: null},
        {articleId: 'article-3', exportedComment: null, radio: null},
      ]),
      [
        {fieldName: getCommentFieldName('article-1'), valueToken: '()'},
        {fieldName: getCommentFieldName('article-2'), valueToken: '(   )'},
        {fieldName: getCommentFieldName('article-3'), valueToken: '(\\007\\000)'},
      ],
    )
    const parsedImport = parsePdfConflictResolutionImport(pdf)

    expect(parsedImport.rows).toMatchObject([{canonicalArticleId: 'article-1', comment: null}])
    expect(parsedImport.commentOnlyRows).toEqual([])
  })

  test('parses a PDF with only changed comments and builds version 3 artifact rows', () => {
    const commentOnlyPdf = createCommentReviewPdf([
      {articleId: 'article-2', exportedComment: null, value: 'Only a note'},
    ])
    const commentOnlyImport = parsePdfConflictResolutionImport(commentOnlyPdf)

    expect(commentOnlyImport.rows).toEqual([])
    expect(commentOnlyImport.undecidedRows).toEqual([])
    expect(commentOnlyImport.commentOnlyRows).toMatchObject([{canonicalArticleId: 'article-2', comment: 'Only a note'}])

    const artifact = getComparisonProjectConflictResolutionTransferArtifactFromPdfImport(
      parsePdfConflictResolutionImport(
        createCommentReviewPdf([
          {articleId: 'article-1', exportedComment: null, radio: 'yes', value: 'Resolution note'},
          {articleId: 'article-2', exportedComment: null, radio: null, value: 'Comment-only note'},
          {articleId: 'article-3', exportedComment: 'Untouched', radio: 'no'},
          {articleId: 'article-4', exportedComment: 'Untouched', radio: pdfConflictResolutionNotSetValue},
        ]),
      ),
    )

    expect(artifact.version).toBe(3)
    expect(artifact.rows).toEqual([
      {
        sourceResolutionId: 'comparison-project-1:article-1:pdf-resolution',
        sourceArticleRowId: 'article-1',
        externalArticleId: 'EXT-article-1',
        title: 'Title article-1',
        identifiers: [],
        resolution: {mode: 'summary', value: 'yes', label: 'Yes'},
        comment: 'Resolution note',
      },
      {
        sourceResolutionId: 'comparison-project-1:article-3:pdf-resolution',
        sourceArticleRowId: 'article-3',
        externalArticleId: 'EXT-article-3',
        title: 'Title article-3',
        identifiers: [],
        resolution: {mode: 'summary', value: 'no', label: 'No'},
        comment: null,
      },
      {
        sourceResolutionId: 'comparison-project-1:article-2:pdf-comment',
        sourceArticleRowId: 'article-2',
        externalArticleId: 'EXT-article-2',
        title: 'Title article-2',
        identifiers: [],
        resolution: null,
        comment: 'Comment-only note',
      },
    ])
  })

  test('comment-only rows without hidden row metadata import into the same project only', () => {
    const parsedImport = parsePdfConflictResolutionImport(
      createCommentReviewPdf(
        [{articleId: 'article-1', exportedComment: null, value: 'Note', withMetadata: false}],
        false,
      ),
    )

    expect(parsedImport.source.comparisonProjectId).toBe('comparison-project-1')
    expect(
      getComparisonProjectConflictResolutionTransferArtifactFromPdfImport({
        parsedImport,
        targetComparisonProjectId: 'comparison-project-1',
      }).rows,
    ).toMatchObject([
      {sourceResolutionId: 'comparison-project-1:article-1:pdf-comment', resolution: null, comment: 'Note'},
    ])
    expect(() => {
      getComparisonProjectConflictResolutionTransferArtifactFromPdfImport({
        parsedImport,
        targetComparisonProjectId: 'comparison-project-2',
      })
    }).toThrow('PDF has no hidden row metadata')
    expect(
      getComparisonProjectConflictResolutionTransferArtifactFromPdfImport({
        parsedImport: parsePdfConflictResolutionImport(
          createCommentReviewPdf([{articleId: 'article-1', exportedComment: null, value: 'Note'}]),
        ),
        targetComparisonProjectId: 'comparison-project-2',
      }).rows,
    ).toHaveLength(1)
  })

  test('cuts comments to 4000 UTF-16 code units without splitting a surrogate pair', () => {
    const parsedImport = parsePdfConflictResolutionImport(
      createCommentReviewPdf([
        {articleId: 'article-1', exportedComment: null, value: `${'x'.repeat(3999)}\u{1F44D}`},
        {articleId: 'article-2', exportedComment: null, value: 'y'.repeat(4001)},
        {articleId: 'article-3', exportedComment: 'z'.repeat(4000), value: `${'z'.repeat(4000)} more`},
      ]),
    )

    expect(
      parsedImport.commentOnlyRows.map((row) => {
        return [row.canonicalArticleId, row.comment.length]
      }),
    ).toEqual([
      ['article-1', 3999],
      ['article-2', 4000],
    ])
  })

  test('the last incremental update of a field wins and binary appearance streams are skipped', () => {
    const getAppearanceStream = (objectNumber: number, bytes: number[]) => {
      return Buffer.concat([
        Buffer.from(
          `${objectNumber} 0 obj\n<< /Type /XObject /Subtype /Form /Filter /FlateDecode /Length ${bytes.length} >>\nstream\n`,
          'latin1',
        ),
        Buffer.from(bytes),
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ])
    }
    const original = createCommentReviewPdf([{articleId: 'article-1', exportedComment: 'Old', radio: null}])
    const firstEdit = appendViewerFieldUpdates(original, [
      {fieldName: getCommentFieldName('article-1'), valueToken: '(First edit)'},
    ])
    const secondEdit = appendViewerFieldUpdates(
      Buffer.concat([firstEdit, getAppearanceStream(90, [0x3c, 0x3c, 0x01, 0xff, 0x00, 0x9a])]),
      [{fieldName: getCommentFieldName('article-1'), valueToken: '(Second edit)'}],
    )
    const withLaterStream = Buffer.concat([secondEdit, getAppearanceStream(91, [0x02, 0x3e, 0x3e, 0xfe])])

    expect(parsePdfConflictResolutionImport(withLaterStream).commentOnlyRows).toMatchObject([{comment: 'Second edit'}])
  })

  test('reads top-level keys only, so values that look like keys do not confuse the field name', () => {
    const metadata = getMetadataValue({canonicalArticleId: 'article-1', exportedComment: null})
    const pdfSource = `%PDF-1.4
1 0 obj
<</V(see /T \\(x\\) and /FT /Btn)/AA<</V 9 0 R>>/FT/Tx/T(${getCommentFieldName('article-1')})>>
endobj
2 0 obj
<</FT/Tx/T(comparison.comparison-project-1.article.article-1.metadata)/V<${Buffer.from(metadata, 'latin1').toString('hex')}>>>
endobj`

    expect(parsePdfConflictResolutionImport(pdfSource).commentOnlyRows).toMatchObject([
      {
        canonicalArticleId: 'article-1',
        comment: 'see /T (x) and /FT /Btn',
        fieldName: getCommentFieldName('article-1'),
      },
    ])
  })

  test('decodes strings without a BOM as PDFDocEncoding, keeping other Latin-1 bytes and dropping undefined ones', () => {
    const pdf = appendViewerFieldUpdates(
      createCommentReviewPdf([
        {articleId: 'article-1', exportedComment: null},
        {articleId: 'article-2', exportedComment: null},
        {articleId: 'article-3', exportedComment: null},
      ]),
      [
        {fieldName: getCommentFieldName('article-1'), valueToken: '(it\\220s \\205 5 \\240 \\200 \\215ok\\216)'},
        {
          fieldName: getCommentFieldName('article-2'),
          valueToken: '(\\225ukasz \\226uvre \\223le \\030\\037 Gr\\374\\337e)',
        },
        {fieldName: getCommentFieldName('article-3'), valueToken: '(a\\177b\\237c\\255d)'},
        {fieldName: 'forska.reviewer.displayName', valueToken: '(O\\220Brien)'},
      ],
    )
    const parsedImport = parsePdfConflictResolutionImport(pdf)

    expect(parsedImport.reviewer.displayName).toBe('O\u2019Brien')
    expect(
      parsedImport.commentOnlyRows.map((row) => {
        return row.comment
      }),
    ).toEqual([
      'it\u2019s \u2013 5 \u20ac \u2022 \u201cok\u201d',
      '\u0141ukasz \u0152uvre \ufb01le \u02d8\u02dc Gr\u00fc\u00dfe',
      'abcd',
    ])
  })

  test('an untouched prefilled comment that a viewer re-encoded as PDFDocEncoding does not count as changed', () => {
    const pdf = appendViewerFieldUpdates(
      createCommentReviewPdf([
        {articleId: 'article-1', exportedComment: 'Patient\u2019s age \u2013 unclear', radio: 'yes'},
        {articleId: 'article-2', exportedComment: '\u201cQuoted\u201d \u2026 \u20ac5', radio: null},
      ]),
      [
        {fieldName: getCommentFieldName('article-1'), valueToken: '(Patient\\220s age \\205 unclear)'},
        {fieldName: getCommentFieldName('article-2'), valueToken: '(\\215Quoted\\216 \\203 \\2405)'},
      ],
    )
    const parsedImport = parsePdfConflictResolutionImport(pdf)

    expect(parsedImport.rows).toMatchObject([{canonicalArticleId: 'article-1', comment: null, resolutionValue: 'yes'}])
    expect(parsedImport.commentOnlyRows).toEqual([])
  })

  test('decodes a UTF-16LE BOM', () => {
    const pdf = appendViewerFieldUpdates(createCommentReviewPdf([{articleId: 'article-1', exportedComment: null}]), [
      {fieldName: getCommentFieldName('article-1'), valueToken: '<FFFE 4100 E500 0D00 0A00 4200>'},
    ])

    expect(parsePdfConflictResolutionImport(pdf).commentOnlyRows).toMatchObject([{comment: 'A\u00e5\nB'}])
  })

  test('a literal value containing >> stream and a raw line break does not hide later fields', () => {
    const edited = appendViewerFieldUpdates(
      createCommentReviewPdf([
        {articleId: 'article-1', exportedComment: null},
        {articleId: 'article-3', exportedComment: null},
      ]),
      [
        {fieldName: getCommentFieldName('article-1'), valueToken: '(see >> stream\nline)'},
        {fieldName: getCommentFieldName('article-3'), valueToken: '(Third)'},
      ],
    )
    const withAppearanceStream = Buffer.concat([
      edited,
      Buffer.from(
        '90 0 obj\n<< /Type /XObject /Subtype /Form /Length 9 >>\nstream\nq BT ET Q\nendstream\nendobj\n',
        'latin1',
      ),
    ])

    expect(
      parsePdfConflictResolutionImport(withAppearanceStream).commentOnlyRows.map((row) => {
        return [row.canonicalArticleId, row.comment]
      }),
    ).toEqual([
      ['article-1', 'see >> stream\nline'],
      ['article-3', 'Third'],
    ])
  })

  test('skips stream data by its direct length even when the data contains endstream and field-like text', () => {
    const streamData =
      'BT (endstream) Tj ET\nendstream\n<< /FT /Tx /T (comparison.comparison-project-1.article.article-2.comment) /V (Fake) >>\n'
    const withStream = Buffer.concat([
      createCommentReviewPdf([
        {articleId: 'article-1', exportedComment: null, value: 'Real note'},
        {articleId: 'article-2', exportedComment: null},
      ]),
      Buffer.from(`91 0 obj\n<< /Length ${streamData.length} >>\nstream\n${streamData}\nendstream\nendobj\n`, 'latin1'),
    ])

    expect(
      parsePdfConflictResolutionImport(withStream).commentOnlyRows.map((row) => {
        return [row.canonicalArticleId, row.comment]
      }),
    ).toEqual([['article-1', 'Real note']])
  })

  test('resolves an indirect value that points at a plain string object and warns about other indirect values', () => {
    const withObjects = Buffer.concat([
      createCommentReviewPdf([
        {articleId: 'article-1', exportedComment: null},
        {articleId: 'article-2', exportedComment: 'Old'},
      ]),
      Buffer.from(
        '40 0 obj\n(Stale indirect note)\nendobj\n40 0 obj\n<FEFF0049006E0064006900720065006B0074>\nendobj\n',
        'latin1',
      ),
      Buffer.from('41 0 obj\n<< /Length 4 >>\nstream\nText\nendstream\nendobj\n', 'latin1'),
    ])
    const parsedImport = parsePdfConflictResolutionImport(
      appendViewerFieldUpdates(withObjects, [
        {fieldName: getCommentFieldName('article-1'), valueToken: ' 40 0 R'},
        {fieldName: getCommentFieldName('article-2'), valueToken: ' 41 0 R'},
      ]),
    )

    expect(
      parsedImport.commentOnlyRows.map((row) => {
        return [row.canonicalArticleId, row.comment]
      }),
    ).toEqual([['article-1', 'Indirekt']])
    expect(parsedImport.warnings).toContain(
      `PDF field ${getCommentFieldName('article-2')} has an indirect value that is not a plain string object and was ignored.`,
    )
  })

  test('an indirect string redefined later as a stream or dictionary is not read as stale text', () => {
    const withObjects = Buffer.concat([
      createCommentReviewPdf([
        {articleId: 'article-1', exportedComment: null},
        {articleId: 'article-2', exportedComment: null},
        {articleId: 'article-3', exportedComment: null},
      ]),
      Buffer.from(
        '40 0 obj\n(stale first draft)\nendobj\n41 0 obj\n(stale second draft)\nendobj\n42 0 obj\n(kept)\nendobj\n',
        'latin1',
      ),
      Buffer.from(
        '40 0 obj\n<< /Length 5 >>\nstream\nhello\nendstream\nendobj\n41 0 obj\n<< /Kind /Other >>\nendobj\n',
        'latin1',
      ),
    ])
    const parsedImport = parsePdfConflictResolutionImport(
      appendViewerFieldUpdates(withObjects, [
        {fieldName: getCommentFieldName('article-1'), valueToken: ' 40 0 R'},
        {fieldName: getCommentFieldName('article-2'), valueToken: ' 41 0 R'},
        {fieldName: getCommentFieldName('article-3'), valueToken: ' 42 0 R'},
      ]),
    )

    expect(
      parsedImport.commentOnlyRows.map((row) => {
        return [row.canonicalArticleId, row.comment]
      }),
    ).toEqual([['article-3', 'kept']])
    expect(parsedImport.warnings).toEqual(
      expect.arrayContaining([
        `PDF field ${getCommentFieldName('article-1')} has an indirect value that is not a plain string object and was ignored.`,
        `PDF field ${getCommentFieldName('article-2')} has an indirect value that is not a plain string object and was ignored.`,
      ]) as string[],
    )
  })

  test('the error for a PDF without changes names indirect values that were ignored', () => {
    const withStream = Buffer.concat([
      createCommentReviewPdf([{articleId: 'article-1', exportedComment: null}]),
      Buffer.from('961 0 obj\n<< /Length 5 >>\nstream\nhello\nendstream\nendobj\n', 'latin1'),
    ])

    expect(() => {
      parsePdfConflictResolutionImport(
        appendViewerFieldUpdates(withStream, [{fieldName: getCommentFieldName('article-1'), valueToken: ' 961 0 R'}]),
      )
    }).toThrow(
      `The selected PDF has no filled conflict-resolution radio fields and no changed comments. PDF field ${getCommentFieldName('article-1')} has an indirect value that is not a plain string object and was ignored.`,
    )
  })

  test('counts an article with an Undecided radio and a changed comment once', () => {
    const parsedImport = parsePdfConflictResolutionImport(
      createCommentReviewPdf([
        {articleId: 'article-1', exportedComment: null, radio: pdfConflictResolutionNotSetValue, value: 'Note'},
        {articleId: 'article-2', exportedComment: null, radio: 'yes', value: 'Other'},
        {articleId: 'article-3', exportedComment: null, radio: null, value: 'Third'},
      ]),
    )

    expect(parsedImport.undecidedRows).toHaveLength(1)
    expect(parsedImport.commentOnlyRows).toHaveLength(2)
    expect(parsedImport.rows).toHaveLength(1)
    expect(getParsedPdfConflictResolutionImportArticleCount(parsedImport)).toBe(3)
  })
})
