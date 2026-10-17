import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {
  buildCanonicalFullText,
  CANONICAL_TEXT_VERSION,
  type CanonicalFullTextAsset,
  type FullTextFigureMode,
} from './canonicalFullText.ts'
import {type FullTextConverterKind, type FullTextLayoutBlock} from './converters/fullTextConverterTypes.ts'

type FixtureName = 'arxiv-2111.06377' | 'frontiers-fmed-2023-1283512'

const frozenGoldenHashes = {
  'arxiv-2111.06377.docling.none': '78d84e568894b305fe58409d19c47e1bb0ff6da96108e41910729f3be702a6d0',
  'arxiv-2111.06377.mineru.none': '7439c8f5d2dfcd1a4b5c9e8d30c980f1c60c2d565a9360bbb80df781aaf1e1d5',
  'frontiers-fmed-2023-1283512.docling.none': '5b095ff6379d10d4d41140d73e241771cad17dc953e474cf2700d7b79e5ca3c2',
  'frontiers-fmed-2023-1283512.mineru.native_images':
    '401b62d6e2f1b97f09afe6af3b5e8563b58bdfd48677bcc45bd3c63208f544c4',
  'frontiers-fmed-2023-1283512.mineru.none': 'cece6ecb280c032b4ebbd648c99e4239e8e79d16012d317f04fad7ed1074294e',
}

const readFixture = (fileName: string): string => {
  return readFileSync(new URL(`./fixtures/canonical/${fileName}`, import.meta.url), 'utf8')
}

const buildFixture = ({
  converterKind,
  figureMode,
  name,
}: {
  converterKind: FullTextConverterKind
  figureMode: FullTextFigureMode
  name: FixtureName
}) => {
  const layoutFile = JSON.parse(readFixture(`${name}.${converterKind}.layout.json`)) as {blocks: FullTextLayoutBlock[]}
  const assets = JSON.parse(readFixture(`${name}.${converterKind}.assets.json`)) as CanonicalFullTextAsset[]

  return buildCanonicalFullText({assets, converterKind, figureMode, layout: layoutFile.blocks})
}

const block = (type: string, text: string, extra: Partial<FullTextLayoutBlock> = {}): FullTextLayoutBlock => {
  return {bbox: null, page: 1, text, type, ...extra}
}

const buildMineru = (
  layout: FullTextLayoutBlock[],
  figureMode: FullTextFigureMode = 'none',
  assets: CanonicalFullTextAsset[] = [],
) => {
  return buildCanonicalFullText({assets, converterKind: 'mineru', figureMode, layout})
}

const getBlocks = (text: string): string[] => {
  return text.trimEnd().split('\n\n')
}

test('golden fixtures rebuild to the frozen bytes and hashes of canonical-v1', () => {
  expect(CANONICAL_TEXT_VERSION).toBe('canonical-v1')

  Object.entries(frozenGoldenHashes).map(([key, hash]) => {
    const [name, converterKind, figureMode] = [
      key.split('.').slice(0, -2).join('.') as FixtureName,
      key.split('.').at(-2) as FullTextConverterKind,
      key.split('.').at(-1) as FullTextFigureMode,
    ]
    const result = buildFixture({converterKind, figureMode, name})

    expect(result.text).toBe(readFixture(`${key}.md`))
    expect(result.hash).toBe(hash)
    expect(result.version).toBe('canonical-v1')
  })
})

test('Frontiers fixtures drop references, page furniture, front matter and affiliations but keep funding and COI', () => {
  const texts = (['mineru', 'docling'] as const).map((converterKind) => {
    return buildFixture({converterKind, figureMode: 'none', name: 'frontiers-fmed-2023-1283512'}).text
  })

  texts.map((text) => {
    expect(text.startsWith('## 1 Introduction\n\n')).toBe(true)
    expect(text).not.toContain('Ischiorectal fossa block decreases posthemorrhoidectomy pain')
    expect(text).not.toContain('Higgins J, Altman D')
    expect(text).not.toContain('frontiersin.org')
    expect(text).not.toContain('10.3389/fmed.2023.1283512')
    expect(text).not.toContain('Shenzhen Hospital of Guangzhou University of Chinese Medicine')
    expect(text).not.toContain('1053660645@qq.com')
    expect(text).not.toContain('EDITED BY')
    expect(text).not.toContain('The role of pudendal nerve block in hemorrhoid surgery')
    expect(text).not.toContain('Background: Pudendal nerve block')
    expect(text).not.toContain('KEYWORDS')
    expect(text).not.toContain('Abbreviations:')
    expect(text).toContain('## 2 Materials and methods > 2.1 Search strategy')
    expect(text).toContain('## Funding\n\nThe authors declare that no financial support was received')
    expect(text).toContain('## Conflict of interest\n\nThe authors declare that the research was conducted')
    expect(text).toContain('## Data availability statement\n\nPublicly available datasets were analyzed')
  })
  expect(texts[1]).not.toContain('Study or Subgroup')
})

test('arXiv fixtures drop the title, authors, abstract and bibliography and keep appendix heading paths', () => {
  ;(['mineru', 'docling'] as const).map((converterKind) => {
    const result = buildFixture({converterKind, figureMode: 'none', name: 'arxiv-2111.06377'})

    expect(result.text).not.toContain('Masked Autoencoders Are Scalable Vision Learners')
    expect(result.text).not.toContain('Kaiming')
    expect(result.text).not.toContain('Abstract')
    expect(result.text).not.toContain('arXiv:2111.06377')
    expect(result.text).not.toContain('Samira Abnar')
    expect(result.text).not.toContain('## References')
    expect(result.text).toContain('## 4. ImageNet Experiments > 4.1. Main Properties')
    expect(result.text).toContain('## A. Implementation Details > A.1. ImageNet Experiments')
    expect(result.stats.droppedBlocks.references_section).toBeGreaterThan(0)
  })
})

test('every table in the golden fixtures stays inside one block', () => {
  Object.keys(frozenGoldenHashes).map((key) => {
    const blocks = getBlocks(readFixture(`${key}.md`))

    blocks.map((current, index) => {
      const next = blocks[index + 1]
      const endsWithTableRow = current.split('\n').at(-1)?.startsWith('|') ?? false

      expect(endsWithTableRow && next?.startsWith('|')).toBe(false)
      expect(
        current.split('\n').filter((line) => {
          return line.startsWith('| --- ')
        }).length,
      ).toBeLessThanOrEqual(1)
    })
  })
})

test('MinerU HTML tables become one pipe-table block with spans expanded, caption and footnote attached', () => {
  const result = buildMineru([
    block('table', '', {
      parts: [
        {text: 'Table 2 Baseline characteristics', type: 'table_caption'},
        {
          text: '<table><tr><td rowspan="2">Group</td><td colspan="2">Age &amp; sex</td></tr><tr><td>Age</td><td>Male | n</td></tr><tr><td>PNB</td><td>45</td><td>12</td></tr></table>',
          type: 'table_body',
        },
        {text: 'Values are means.', type: 'table_footnote'},
      ],
    }),
  ])

  expect(result.text).toBe(
    [
      'Table 2 Baseline characteristics',
      '| Group | Age & sex | Age & sex |',
      '| --- | --- | --- |',
      '| Group | Age | Male \\| n |',
      '| PNB | 45 | 12 |',
      'Values are means.',
      '',
    ].join('\n'),
  )
  expect(result.stats.tables).toBe(1)
})

test('a MinerU table continued on the next page merges into the previous table without repeating the header', () => {
  const header = '<tr><td>Study</td><td>n</td></tr>'
  const result = buildMineru([
    block('table', '', {parts: [{text: `<table>${header}<tr><td>A</td><td>1</td></tr></table>`, type: 'table_body'}]}),
    block('text', 'Paragraph between the parts.', {page: 2}),
    block('table', '', {
      continuesPrevious: true,
      page: 2,
      parts: [{text: `<table>${header}<tr><td>B</td><td>2</td></tr></table>`, type: 'table_body'}],
    }),
  ])

  expect(getBlocks(result.text)).toEqual([
    '| Study | n |\n| --- | --- |\n| A | 1 |\n| B | 2 |',
    'Paragraph between the parts.',
  ])
})

const figureLayout = [
  block('paragraph_title', '2 Methods', {level: 2}),
  block('text', 'Body before the figures.'),
  block('image', '', {figureIndex: 1}),
  block('chart', '', {figureIndex: 2}),
]
const figureAssets: CanonicalFullTextAsset[] = [
  {caption: 'FIGURE 1 Flow   diagram.', description: 'Boxes from 611 records down to 6 trials.', index: 1},
  {caption: null, index: 2},
]

test('figure blocks follow the figure mode and asset numbering', () => {
  const none = buildMineru(figureLayout, 'none', figureAssets)
  const descriptions = buildMineru(figureLayout, 'descriptions', figureAssets)
  const nativeImages = buildMineru(figureLayout, 'native_images', figureAssets)

  expect(getBlocks(none.text).slice(2)).toEqual(['Figure 1: FIGURE 1 Flow diagram.', 'Figure 2'])
  expect(none.stats.missingDescriptions).toBe(0)
  expect(getBlocks(descriptions.text).slice(2)).toEqual([
    'Figure 1: FIGURE 1 Flow diagram.\nDescription: Boxes from 611 records down to 6 trials.',
    'Figure 2',
  ])
  expect(descriptions.stats.missingDescriptions).toBe(1)
  expect(descriptions.text).not.toContain('not yet available')
  expect(getBlocks(nativeImages.text).slice(2)).toEqual([
    'Figure 1: FIGURE 1 Flow diagram.\n[figure:1]',
    'Figure 2\n[figure:2]',
  ])
  expect(new Set([none.hash, descriptions.hash, nativeImages.hash]).size).toBe(3)
})

test('the native-images golden carries one ordered marker per figure', () => {
  const result = buildFixture({
    converterKind: 'mineru',
    figureMode: 'native_images',
    name: 'frontiers-fmed-2023-1283512',
  })
  const markers = [...result.text.matchAll(/^\[figure:(\d+)\]$/gm)].map((match) => {
    return Number(match[1])
  })

  expect(markers).toEqual([1, 2, 3, 4, 5, 6, 7])
  expect(markers.length).toBe(result.stats.figures)
})

test('building twice gives identical bytes, NFC text, single blank lines and one trailing newline', () => {
  const layout = [
    block('paragraph_title', 'Méthods', {level: 2}),
    block('text', '  Café\tand  crème\n brûlée  '),
    block('text', ''),
    block('equation', 'E = mc^2'),
  ]
  const first = buildMineru(layout)
  const second = buildMineru(layout)

  expect(first.text).toBe(second.text)
  expect(first.hash).toBe(second.hash)
  expect(first.text).toBe('## Méthods\n\nCafé and crème brûlée\n\n$$\nE = mc^2\n$$\n')
  expect(first.text).toBe(first.text.normalize('NFC'))
  expect(first.text).not.toMatch(/\n{3}|[ \t]\n/)
  expect(first.text.endsWith('\n\n')).toBe(false)
  expect(first.stats.droppedBlocks.empty).toBe(1)
})

test('MinerU continuations join across floats and dehyphenate like MinerU', () => {
  const result = buildMineru(
    [
      block('text', 'Little high-level un-'),
      block('image', '', {figureIndex: 1}),
      block('text', 'derstanding of self-', {continuesPrevious: true}),
      block('text', 'supervised GPT-', {continuesPrevious: true}),
      block('text', 'style models.', {continuesPrevious: true}),
    ],
    'none',
    [{caption: 'Figure 1', index: 1}],
  )

  expect(getBlocks(result.text)).toEqual([
    'Little high-level understanding of self-supervised GPT-style models.',
    'Figure 1: Figure 1',
  ])
})

test('correspondence, supplementary links and late reference entries are removed, acknowledgements kept', () => {
  const result = buildMineru([
    block('paragraph_title', '1 Introduction', {level: 2}),
    block('text', 'Intro text.'),
    block('text', '*Correspondence: Jane Doe, jane@example.org'),
    block('paragraph_title', 'Acknowledgments', {level: 2}),
    block('text', 'We thank the nurses.'),
    block('paragraph_title', 'Supplementary material', {level: 2}),
    block('text', 'The Supplementary Material for this article can be found online at: https://example.org/supp'),
    block('text', 'Data_Sheet_1.docx'),
    block('paragraph_title', 'References', {level: 2}),
    block('text', '1. Smith J, Doe A. A trial. Lancet. (2020) 1:1-2.'),
    block('paragraph_title', 'Author contributions', {level: 2}),
    block('text', 'JD wrote the paper.'),
    block('text', '9. He J, Zhang L, Li D. Ultrasound-guided block. J Surg. (2021) 3:4-5.'),
    block('text', 'stay: a trial. J Invest Surg. (2018) 31:420-4. doi: 10.1080/08941939.2017.1349221'),
  ])

  expect(result.text).toBe(
    [
      '## 1 Introduction',
      'Intro text.',
      '## Acknowledgments',
      'We thank the nurses.',
      '## Author contributions',
      'JD wrote the paper.',
    ].join('\n\n') + '\n',
  )
  expect(result.stats.droppedBlocks).toEqual({
    correspondence: 1,
    empty_heading: 1,
    reference: 2,
    references_section: 2,
    supplementary_link: 2,
  })
})

test('front matter needs a body heading within the first pages and late front-matter-like headings are body text', () => {
  const noHeadings = buildMineru([block('text', 'Letter body one.'), block('text', 'Letter body two.')])
  const lateOpenAccess = buildMineru([
    block('paragraph_title', 'Abstract', {level: 2}),
    block('text', 'Abstract text.'),
    block('paragraph_title', 'Introduction', {level: 2}),
    block('text', 'Intro.'),
    block('paragraph_title', 'Open Access', {level: 2, page: 9}),
    block('text', 'This article is licensed under CC BY.', {page: 9}),
  ])

  expect(noHeadings.text).toBe('Letter body one.\n\nLetter body two.\n')
  expect(noHeadings.stats.droppedBlocks.front_matter).toBeUndefined()
  expect(lateOpenAccess.text).toBe(
    '## Introduction\n\nIntro.\n\n## Open Access\n\nThis article is licensed under CC BY.\n',
  )
  expect(lateOpenAccess.stats.droppedBlocks.front_matter).toBe(2)
})

test('Docling picture text, table captions and furniture are dropped while list items keep their markers', () => {
  const result = buildCanonicalFullText({
    assets: [{caption: 'FIGURE 1 Forest plot.', index: 1}],
    converterKind: 'docling',
    figureMode: 'none',
    layout: [
      block('section_header', '3 Results', {level: 1}),
      block('page_header', 'Frontiers in Medicine'),
      block('list_item', 'First outcome', {listMarker: '-'}),
      block('list_item', '2. Second outcome', {listMarker: '2.'}),
      block('picture', '', {figureIndex: 1}),
      block('text', 'Study or Subgroup', {container: 'picture'}),
      block('table', '| a | b |\n| --- | --- |\n| 1 | 2 |', {
        parts: [
          {text: 'TABLE 1 Trials.', type: 'table_caption'},
          {text: '| a | b |\n| --- | --- |\n| 1 | 2 |', type: 'table_body'},
        ],
      }),
      block('caption', 'TABLE 1 Trials.', {container: 'table'}),
      block('footnote', 'Abbreviations: PNB.'),
      block('formula', 'x = 1'),
    ],
  })

  expect(getBlocks(result.text)).toEqual([
    '## 3 Results',
    '- First outcome\n2. Second outcome',
    'Figure 1: FIGURE 1 Forest plot.',
    'TABLE 1 Trials.\n| a | b |\n| --- | --- |\n| 1 | 2 |',
    'x = 1',
  ])
  expect(result.stats.droppedBlocks).toEqual({
    attached_to_table: 1,
    figure_internal_text: 1,
    page_footnote: 1,
    page_furniture: 1,
  })
})

test('inconsistent inputs fail explicitly instead of degrading', () => {
  const body = [block('text', 'Body.')]

  expect(() => {
    return buildMineru(body, 'pictures' as FullTextFigureMode)
  }).toThrow('unknown figure mode pictures')
  expect(() => {
    return buildMineru([...body, block('image', '', {figureIndex: 2})])
  }).toThrow('layout places figure 2 but full_text_assets has no entry with that index')
  expect(() => {
    return buildMineru(body, 'none', [{caption: null, index: 1}])
  }).toThrow('full_text_assets figure 1 has no layout block')
  expect(() => {
    return buildMineru([block('header', 'Running head')])
  }).toThrow('no body text is left after the strip rules')
})

test('a figure block without a crop keeps its caption as body text and gets no figure number', () => {
  const result = buildMineru([
    block('text', 'Body.'),
    block('image', '', {parts: [{text: 'FIGURE 2 Risk of bias.', type: 'image_caption'}]}),
    block('chart', ''),
  ])

  expect(getBlocks(result.text)).toEqual(['Body.', 'FIGURE 2 Risk of bias.'])
  expect(result.stats.figures).toBe(0)
  expect(result.stats.droppedBlocks.empty).toBe(1)
})
