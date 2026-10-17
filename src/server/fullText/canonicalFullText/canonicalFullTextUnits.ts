import {
  type FullTextConverterKind,
  type FullTextLayoutBlock,
  type FullTextLayoutPart,
} from '../converters/fullTextConverterTypes.ts'
import {getHtmlTableGridRows, getPipeTableRows, isHtmlTable, isPipeTable} from './canonicalFullTextTables.ts'

export type CanonicalDropReason =
  | 'affiliation_section'
  | 'attached_to_table'
  | 'correspondence'
  | 'empty'
  | 'empty_heading'
  | 'figure_internal_text'
  | 'front_matter'
  | 'page_footnote'
  | 'page_furniture'
  | 'reference'
  | 'references_section'
  | 'supplementary_link'
  | 'table_of_contents'
  | 'title'

export type CanonicalHeadingUnit = {converterDepth: number | null; kind: 'heading'; page: number; text: string}
export type CanonicalParagraphUnit = {continuesPrevious: boolean; kind: 'paragraph'; page: number; text: string}
export type CanonicalListItemUnit = {
  depth: number
  kind: 'list_item'
  marker: string | null
  page: number
  text: string
}
export type CanonicalTableUnit = {
  bodyText: string | null
  captions: string[]
  continuesPrevious: boolean
  footnotes: string[]
  kind: 'table'
  page: number
  rows: string[][] | null
}
export type CanonicalFigureUnit = {figureIndex: number; kind: 'figure'; page: number}
export type CanonicalEquationUnit = {kind: 'equation'; latex: boolean; page: number; text: string}
export type CanonicalCodeUnit = {body: string; captions: string[]; footnotes: string[]; kind: 'code'; page: number}

export type CanonicalUnit =
  | CanonicalCodeUnit
  | CanonicalEquationUnit
  | CanonicalFigureUnit
  | CanonicalHeadingUnit
  | CanonicalListItemUnit
  | CanonicalParagraphUnit
  | CanonicalTableUnit

export type CanonicalUnitSequence = {drops: CanonicalDropReason[]; units: CanonicalUnit[]}

type BlockClassification = CanonicalUnitSequence & {unknownType: string | null}

const mineruFurnitureTypes = new Set(['aside_text', 'footer', 'header', 'page_number'])
const doclingFurnitureLabels = new Set(['page_footer', 'page_header'])
const doclingParagraphLabels = new Set(['caption', 'paragraph', 'text'])
const compoundPrefixes = new Set([
  'anti',
  'co',
  'cross',
  'multi',
  'non',
  'open',
  'post',
  'pre',
  'quasi',
  'self',
  'semi',
])
const compoundConnectors = new Set(['and', 'by', 'for', 'in', 'of', 'on', 'the', 'to', 'with'])

export const normalizeInlineText = (value: string): string => {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim()
}

const dropped = (reason: CanonicalDropReason): BlockClassification => {
  return {drops: [reason], unknownType: null, units: []}
}

const kept = (units: CanonicalUnit[]): BlockClassification => {
  return {drops: [], unknownType: null, units}
}

const getPartTexts = (parts: FullTextLayoutPart[], suffix: string): string[] => {
  return parts
    .filter((part) => {
      return part.type.endsWith(suffix)
    })
    .map((part) => {
      return normalizeInlineText(part.text)
    })
    .filter((text) => {
      return text !== ''
    })
}

const getTableBodyText = (block: FullTextLayoutBlock): string => {
  const body = (block.parts ?? []).find((part) => {
    return part.type === 'table_body'
  })

  return (body ? body.text : block.text).normalize('NFC').trim()
}

const getTableRows = (body: string): string[][] | null => {
  const rows = isHtmlTable(body) ? getHtmlTableGridRows(body) : isPipeTable(body) ? getPipeTableRows(body) : null

  return rows && rows.length > 0 ? rows : null
}

const classifyTable = (block: FullTextLayoutBlock): BlockClassification => {
  const parts = block.parts ?? []
  const body = getTableBodyText(block)
  const rows = getTableRows(body)
  const unit: CanonicalTableUnit = {
    bodyText: rows || body === '' ? null : body,
    captions: getPartTexts(parts, '_caption'),
    continuesPrevious: block.continuesPrevious === true,
    footnotes: getPartTexts(parts, '_footnote'),
    kind: 'table',
    page: block.page,
    rows,
  }

  return unit.rows || unit.bodyText || unit.captions.length > 0 ? kept([unit]) : dropped('empty')
}

const getParagraphUnit = (block: FullTextLayoutBlock, text: string): CanonicalParagraphUnit => {
  return {continuesPrevious: block.continuesPrevious === true, kind: 'paragraph', page: block.page, text}
}

const classifyUnplacedVisual = (block: FullTextLayoutBlock): BlockClassification => {
  const captionTexts = [...getPartTexts(block.parts ?? [], '_caption'), ...getPartTexts(block.parts ?? [], '_footnote')]

  return captionTexts.length > 0
    ? kept(
        captionTexts.map((text): CanonicalParagraphUnit => {
          return {continuesPrevious: false, kind: 'paragraph', page: block.page, text}
        }),
      )
    : dropped('empty')
}

const classifyVisual = (block: FullTextLayoutBlock): BlockClassification => {
  return block.figureIndex === undefined
    ? classifyUnplacedVisual(block)
    : kept([{figureIndex: block.figureIndex, kind: 'figure', page: block.page}])
}

const classifyText = (block: FullTextLayoutBlock): BlockClassification => {
  const text = normalizeInlineText(block.text)

  return text === '' ? dropped('empty') : kept([getParagraphUnit(block, text)])
}

const classifyHeading = (block: FullTextLayoutBlock, converterDepth: number | null): BlockClassification => {
  const text = normalizeInlineText(block.text)

  return text === '' ? dropped('empty') : kept([{converterDepth, kind: 'heading', page: block.page, text}])
}

const classifyEquation = (block: FullTextLayoutBlock, latex: boolean): BlockClassification => {
  const text = block.text.normalize('NFC').trim()

  return text === '' ? dropped('empty') : kept([{kind: 'equation', latex, page: block.page, text}])
}

const classifyCode = (block: FullTextLayoutBlock): BlockClassification => {
  const parts = block.parts ?? []
  const bodyPart = parts.find((part) => {
    return part.type === 'code_body' || part.type === 'algorithm_body'
  })
  const body = (bodyPart ? bodyPart.text : block.text).normalize('NFC').trim()

  return body === ''
    ? dropped('empty')
    : kept([
        {
          body,
          captions: getPartTexts(parts, '_caption'),
          footnotes: getPartTexts(parts, '_footnote'),
          kind: 'code',
          page: block.page,
        },
      ])
}

const classifyMineruListPart = (block: FullTextLayoutBlock, part: FullTextLayoutPart): BlockClassification => {
  const text = normalizeInlineText(part.text)

  return part.type === 'ref_text'
    ? dropped('reference')
    : text === ''
      ? dropped('empty')
      : kept([{depth: part.depth ?? 0, kind: 'list_item', marker: null, page: block.page, text}])
}

const mergeClassifications = (classifications: BlockClassification[]): BlockClassification => {
  return {
    drops: classifications.flatMap((classification) => {
      return classification.drops
    }),
    unknownType: null,
    units: classifications.flatMap((classification) => {
      return classification.units
    }),
  }
}

const classifyMineruList = (block: FullTextLayoutBlock): BlockClassification => {
  const parts = block.parts ?? []

  return parts.length === 0
    ? dropped('empty')
    : mergeClassifications(
        parts.map((part) => {
          return classifyMineruListPart(block, part)
        }),
      )
}

const classifyUnknown = (block: FullTextLayoutBlock): BlockClassification => {
  return {...classifyText(block), unknownType: block.type}
}

const getMineruHeadingDepth = (block: FullTextLayoutBlock): number | null => {
  return typeof block.level === 'number' && block.level >= 2 ? block.level - 1 : null
}

const classifyMineruBlock = (block: FullTextLayoutBlock): BlockClassification => {
  const classifiers: Record<string, () => BlockClassification> = {
    chart: () => {
      return classifyVisual(block)
    },
    code: () => {
      return classifyCode(block)
    },
    doc_title: () => {
      return dropped('title')
    },
    equation: () => {
      return classifyEquation(block, true)
    },
    image: () => {
      return classifyVisual(block)
    },
    index: () => {
      return dropped('table_of_contents')
    },
    list: () => {
      return classifyMineruList(block)
    },
    page_footnote: () => {
      return dropped('page_footnote')
    },
    paragraph_title: () => {
      return classifyHeading(block, getMineruHeadingDepth(block))
    },
    ref_text: () => {
      return dropped('reference')
    },
    table: () => {
      return classifyTable(block)
    },
    text: () => {
      return classifyText(block)
    },
  }
  const classifier = classifiers[block.type]

  return mineruFurnitureTypes.has(block.type)
    ? dropped('page_furniture')
    : classifier
      ? classifier()
      : classifyUnknown(block)
}

const classifyDoclingListItem = (block: FullTextLayoutBlock): BlockClassification => {
  const text = normalizeInlineText(block.text)

  return text === ''
    ? dropped('empty')
    : kept([{depth: 0, kind: 'list_item', marker: block.listMarker ?? null, page: block.page, text}])
}

const classifyDoclingContent = (block: FullTextLayoutBlock): BlockClassification => {
  const classifiers: Record<string, () => BlockClassification> = {
    chart: () => {
      return classifyVisual(block)
    },
    code: () => {
      return classifyCode(block)
    },
    document_index: () => {
      return dropped('table_of_contents')
    },
    footnote: () => {
      return dropped('page_footnote')
    },
    formula: () => {
      return classifyEquation(block, false)
    },
    list_item: () => {
      return classifyDoclingListItem(block)
    },
    picture: () => {
      return classifyVisual(block)
    },
    reference: () => {
      return dropped('reference')
    },
    section_header: () => {
      return classifyHeading(block, typeof block.level === 'number' ? block.level : null)
    },
    table: () => {
      return classifyTable(block)
    },
    title: () => {
      return dropped('title')
    },
  }
  const classifier = classifiers[block.type]

  return doclingFurnitureLabels.has(block.type)
    ? dropped('page_furniture')
    : classifier
      ? classifier()
      : doclingParagraphLabels.has(block.type)
        ? classifyText(block)
        : classifyUnknown(block)
}

const classifyDoclingBlock = (block: FullTextLayoutBlock): BlockClassification => {
  return block.container === 'picture' && block.figureIndex === undefined
    ? dropped('figure_internal_text')
    : block.container === 'table'
      ? dropped('attached_to_table')
      : classifyDoclingContent(block)
}

const getLastHyphenWord = (text: string): RegExpExecArray | null => {
  return /([A-Za-z]+)[-­‐‑⁃]$/.exec(text)
}

const isHardCompoundHyphen = (text: string, match: RegExpExecArray): boolean => {
  const word = (match[1] ?? '').toLowerCase()

  return (
    text.endsWith('-')
    && (compoundPrefixes.has(word)
      || (compoundConnectors.has(word) && match.index > 0 && text[match.index - 1] === '-'))
  )
}

const joinHyphenatedText = (previous: string, next: string, match: RegExpExecArray): string => {
  const word = match[1] ?? ''
  const isAcronym = word.length > 1 && word === word.toUpperCase()
  const shouldDehyphenate = /^\p{Ll}/u.test(next) && !isAcronym && !isHardCompoundHyphen(previous, match)

  return shouldDehyphenate ? `${previous.slice(0, -1)}${next}` : `${previous}${next}`
}

export const joinContinuedText = (previousText: string, nextText: string): string => {
  const previous = previousText.trimEnd()
  const next = nextText.trimStart()
  const hyphenMatch = getLastHyphenWord(previous)

  return previous === '' || next === ''
    ? `${previous}${next}`
    : hyphenMatch
      ? joinHyphenatedText(previous, next, hyphenMatch)
      : /\d[-–]$/.test(previous) && /^\d/.test(next)
        ? `${previous}${next}`
        : `${previous} ${next}`
}

const replaceUnitAt = (units: CanonicalUnit[], index: number, unit: CanonicalUnit): CanonicalUnit[] => {
  return [...units.slice(0, index), unit, ...units.slice(index + 1)]
}

const mergeContinuedParagraph = (units: CanonicalUnit[], unit: CanonicalParagraphUnit): CanonicalUnit[] => {
  const targetIndex = units.findLastIndex((candidate) => {
    return candidate.kind === 'paragraph' || candidate.kind === 'list_item'
  })
  const target = units[targetIndex]

  return target && (target.kind === 'paragraph' || target.kind === 'list_item')
    ? replaceUnitAt(units, targetIndex, {...target, text: joinContinuedText(target.text, unit.text)})
    : [...units, {...unit, continuesPrevious: false}]
}

const getContinuationRows = (previous: string[][], next: string[][]): string[][] => {
  const [previousHeader] = previous
  const [nextHeader, ...nextBody] = next
  const repeatsHeader =
    previousHeader !== undefined && nextHeader !== undefined && previousHeader.join('|') === nextHeader.join('|')

  return [...previous, ...(repeatsHeader ? nextBody : next)]
}

const mergeContinuedTable = (units: CanonicalUnit[], unit: CanonicalTableUnit): CanonicalUnit[] => {
  const targetIndex = units.findLastIndex((candidate) => {
    return candidate.kind === 'table'
  })
  const target = units[targetIndex]

  return target && target.kind === 'table' && target.rows && unit.rows && target.page !== unit.page
    ? replaceUnitAt(units, targetIndex, {
        ...target,
        captions: [...target.captions, ...unit.captions],
        footnotes: [...target.footnotes, ...unit.footnotes],
        rows: getContinuationRows(target.rows, unit.rows),
      })
    : [...units, {...unit, continuesPrevious: false}]
}

const appendUnit = (units: CanonicalUnit[], unit: CanonicalUnit): CanonicalUnit[] => {
  return unit.kind === 'paragraph' && unit.continuesPrevious
    ? mergeContinuedParagraph(units, unit)
    : unit.kind === 'table' && unit.continuesPrevious
      ? mergeContinuedTable(units, unit)
      : [...units, unit]
}

export const getCanonicalUnits = ({
  converterKind,
  layout,
}: {
  converterKind: FullTextConverterKind
  layout: FullTextLayoutBlock[]
}): CanonicalUnitSequence & {unknownTypes: string[]} => {
  const classifications = layout.map(converterKind === 'mineru' ? classifyMineruBlock : classifyDoclingBlock)

  return {
    drops: classifications.flatMap((classification) => {
      return classification.drops
    }),
    unknownTypes: [
      ...new Set(
        classifications.flatMap((classification) => {
          return classification.unknownType === null ? [] : [classification.unknownType]
        }),
      ),
    ].sort(),
    units: classifications
      .flatMap((classification) => {
        return classification.units
      })
      .reduce(appendUnit, []),
  }
}
