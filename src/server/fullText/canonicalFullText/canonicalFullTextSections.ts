import {
  type CanonicalDropReason,
  type CanonicalHeadingUnit,
  type CanonicalUnit,
  type CanonicalUnitSequence,
} from './canonicalFullTextUnits.ts'

export type CanonicalBreadcrumbHeading = {breadcrumb: string[]; kind: 'heading'; page: number}

export type CanonicalRenderUnit = Exclude<CanonicalUnit, CanonicalHeadingUnit> | CanonicalBreadcrumbHeading

type DroppedSection = {depth: number; reason: CanonicalDropReason}

type SectionState = {
  drops: CanonicalDropReason[]
  droppedSection: DroppedSection | null
  referencesSeen: boolean
  supplementaryDepth: number | null
  units: CanonicalUnit[]
}

type BreadcrumbState = {stack: {depth: number; text: string}[]; units: CanonicalRenderUnit[]}

const frontMatterMaxHeadingPage = 2
const frontMatterMaxBodyStartPage = 3
const supplementaryLinkMaxLength = 400
const referenceFragmentMaxLength = 400

const frontMatterHeadingKeys = new Set([
  'abstract',
  'articlehistory',
  'articleinfo',
  'articleinformation',
  'citation',
  'copyright',
  'correspondence',
  'editedby',
  'graphicalabstract',
  'highlights',
  'keypoints',
  'keyword',
  'keywords',
  'openaccess',
  'reviewedby',
  'summary',
])

const referenceHeadingKeys = new Set([
  'bibliography',
  'citedliterature',
  'literaturecited',
  'notesandreferences',
  'reference',
  'referencelist',
  'references',
  'referencesandnotes',
  'workscited',
])

const affiliationHeadingKeys = new Set([
  'affiliations',
  'authoraffiliations',
  'authordetails',
  'authorinformation',
  'authorsaffiliations',
  'authorsdetails',
  'authorsinformation',
])

const supplementaryHeadingKeys = new Set([
  'additionalfiles',
  'electronicsupplementarymaterial',
  'supplementarydata',
  'supplementaryfiles',
  'supplementaryinformation',
  'supplementarymaterial',
  'supplementarymaterials',
  'supportinginformation',
])

export const getHeadingKey = (text: string): string => {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/^[^a-z0-9]*(?:\d+(?:\.\d+)*\.?|[ivxlcdm]+\.|[a-z]\.)\s+/, '')
    .replace(/[^a-z]/g, '')
}

const getHeadingNumberDepth = (text: string): number | null => {
  const match = /^(\d{1,2}(?:\.\d{1,2}){0,5}|[A-Z](?=\.)(?:\.\d{1,2}){0,5})\.?\s+\S/.exec(text)

  return match ? (match[1] as string).split('.').length : null
}

export const getHeadingDepth = (unit: CanonicalHeadingUnit): number => {
  return getHeadingNumberDepth(unit.text) ?? unit.converterDepth ?? 1
}

const isFrontMatterHeading = (unit: CanonicalUnit): boolean => {
  return (
    unit.kind === 'heading'
    && unit.page <= frontMatterMaxHeadingPage
    && frontMatterHeadingKeys.has(getHeadingKey(unit.text))
  )
}

const getBodyStartIndex = (units: CanonicalUnit[]): number => {
  const lastFrontMatterHeadingIndex = units.findLastIndex(isFrontMatterHeading)
  const bodyStartIndex = units.findIndex((unit, index) => {
    return (
      index > lastFrontMatterHeadingIndex
      && unit.kind === 'heading'
      && !frontMatterHeadingKeys.has(getHeadingKey(unit.text))
    )
  })
  const bodyStart = units[bodyStartIndex]

  return bodyStart && bodyStart.page <= frontMatterMaxBodyStartPage ? bodyStartIndex : 0
}

const isKeptFrontMatterUnit = (unit: CanonicalUnit, captionedFigureIndices: Set<number>): boolean => {
  return unit.kind === 'table' || (unit.kind === 'figure' && captionedFigureIndices.has(unit.figureIndex))
}

const dropFrontMatter = (
  sequence: CanonicalUnitSequence,
  captionedFigureIndices: Set<number>,
): CanonicalUnitSequence => {
  const bodyStartIndex = getBodyStartIndex(sequence.units)
  const frontUnits = sequence.units.slice(0, bodyStartIndex)
  const keptFrontUnits = frontUnits.filter((unit) => {
    return isKeptFrontMatterUnit(unit, captionedFigureIndices)
  })

  return {
    drops: [
      ...sequence.drops,
      ...Array.from({length: frontUnits.length - keptFrontUnits.length}, (): CanonicalDropReason => {
        return 'front_matter'
      }),
    ],
    units: [...keptFrontUnits, ...sequence.units.slice(bodyStartIndex)],
  }
}

const isCorrespondenceText = (text: string): boolean => {
  return /^[\s*†‡§¶#✉]*(?:correspondence\b|corresponding authors?\b|address for correspondence\b|address correspondence\b|reprint requests?\b|e-?mail\s*:)/i.test(
    text,
  )
}

const isSupplementaryLinkText = (text: string): boolean => {
  return (
    text.length <= supplementaryLinkMaxLength
    && /supplementa(?:ry|l)|additional files?\b|supporting information/i.test(text)
    && /https?:\/\/|www\.|doi\.org\/|\b10\.\d{4,9}\/|\b(?:can be found|is available|are available|available) (?:online|at)\b/i.test(
      text,
    )
  )
}

const isBareSupplementaryFileText = (text: string): boolean => {
  return /^(?:https?:\/\/\S+|www\.\S+|\S+\.(?:avi|csv|docx?|jpe?g|mov|mp4|pdf|png|pptx?|tiff?|txt|xlsx?|zip))$/i.test(
    text,
  )
}

const isReferenceEntryText = (text: string): boolean => {
  return (
    /^\[?\d{1,3}[.\])]?\s+\p{Lu}[\p{L}'’-]+(?:\s\p{Lu}[\p{L}'’-]+)*\s\p{Lu}{1,3}[,.]/u.test(text)
    || /^\p{Lu}[\p{L}'’-]+,\s(?:\p{Lu}\.\s?)+.*\(\d{4}[a-z]?\)/u.test(text)
    || (text.length <= referenceFragmentMaxLength
      && /\bdoi:\s?10\.\d{4,9}\//i.test(text)
      && /\(\d{4}\)\s?\d/.test(text))
  )
}

const getTextUnitDropReason = (unit: CanonicalUnit, state: SectionState): CanonicalDropReason | null => {
  const text = unit.kind === 'paragraph' || unit.kind === 'list_item' ? unit.text : null

  return text === null
    ? null
    : isCorrespondenceText(text)
      ? 'correspondence'
      : isSupplementaryLinkText(text) || (state.supplementaryDepth !== null && isBareSupplementaryFileText(text))
        ? 'supplementary_link'
        : state.referencesSeen && isReferenceEntryText(text)
          ? 'reference'
          : null
}

const dropUnit = (state: SectionState, reason: CanonicalDropReason): SectionState => {
  return {...state, drops: [...state.drops, reason]}
}

const keepUnit = (state: SectionState, unit: CanonicalUnit): SectionState => {
  return {...state, units: [...state.units, unit]}
}

const getDroppedSection = (key: string, depth: number): DroppedSection | null => {
  return referenceHeadingKeys.has(key)
    ? {depth, reason: 'references_section'}
    : affiliationHeadingKeys.has(key)
      ? {depth, reason: 'affiliation_section'}
      : null
}

const getSupplementaryDepth = (state: SectionState, key: string, depth: number): number | null => {
  return supplementaryHeadingKeys.has(key)
    ? depth
    : state.supplementaryDepth !== null && depth > state.supplementaryDepth
      ? state.supplementaryDepth
      : null
}

const applyHeading = (state: SectionState, unit: CanonicalHeadingUnit): SectionState => {
  const depth = getHeadingDepth(unit)
  const key = getHeadingKey(unit.text)
  const insideDroppedSection = state.droppedSection !== null && depth > state.droppedSection.depth
  const droppedSection = getDroppedSection(key, depth)

  return insideDroppedSection && state.droppedSection
    ? dropUnit(state, state.droppedSection.reason)
    : droppedSection
      ? {
          ...dropUnit(state, droppedSection.reason),
          droppedSection,
          referencesSeen: state.referencesSeen || droppedSection.reason === 'references_section',
          supplementaryDepth: null,
        }
      : {...keepUnit(state, unit), droppedSection: null, supplementaryDepth: getSupplementaryDepth(state, key, depth)}
}

const applyContentUnit = (state: SectionState, unit: CanonicalUnit): SectionState => {
  const isFloat = unit.kind === 'figure' || unit.kind === 'table'
  const textDropReason = getTextUnitDropReason(unit, state)

  return state.droppedSection && !isFloat
    ? dropUnit(state, state.droppedSection.reason)
    : textDropReason
      ? dropUnit(state, textDropReason)
      : keepUnit(state, unit)
}

const applySectionRules = (sequence: CanonicalUnitSequence): CanonicalUnitSequence => {
  const initialState: SectionState = {
    drops: sequence.drops,
    droppedSection: null,
    referencesSeen: false,
    supplementaryDepth: null,
    units: [],
  }
  const finalState = sequence.units.reduce((state, unit) => {
    return unit.kind === 'heading' ? applyHeading(state, unit) : applyContentUnit(state, unit)
  }, initialState)

  return {drops: finalState.drops, units: finalState.units}
}

const applyBreadcrumb = (state: BreadcrumbState, unit: CanonicalUnit): BreadcrumbState => {
  const depth = unit.kind === 'heading' ? getHeadingDepth(unit) : 0
  const stack =
    unit.kind === 'heading'
      ? [
          ...state.stack.filter((entry) => {
            return entry.depth < depth
          }),
          {depth, text: unit.text},
        ]
      : state.stack
  const renderUnit: CanonicalRenderUnit =
    unit.kind === 'heading'
      ? {
          breadcrumb: stack.map((entry) => {
            return entry.text
          }),
          kind: 'heading',
          page: unit.page,
        }
      : unit

  return {stack, units: [...state.units, renderUnit]}
}

const isEmptyHeadingAt = (units: CanonicalRenderUnit[], index: number): boolean => {
  const next = units[index + 1]

  return units[index]?.kind === 'heading' && (next === undefined || next.kind === 'heading')
}

export const getSectionedCanonicalUnits = ({
  captionedFigureIndices,
  sequence,
}: {
  captionedFigureIndices: Set<number>
  sequence: CanonicalUnitSequence
}): {drops: CanonicalDropReason[]; units: CanonicalRenderUnit[]} => {
  const sectioned = applySectionRules(dropFrontMatter(sequence, captionedFigureIndices))
  const withBreadcrumbs = sectioned.units.reduce(applyBreadcrumb, {stack: [], units: []}).units
  const emptyHeadingCount = withBreadcrumbs.filter((_unit, index) => {
    return isEmptyHeadingAt(withBreadcrumbs, index)
  }).length

  return {
    drops: [
      ...sectioned.drops,
      ...Array.from({length: emptyHeadingCount}, (): CanonicalDropReason => {
        return 'empty_heading'
      }),
    ],
    units: withBreadcrumbs.filter((_unit, index) => {
      return !isEmptyHeadingAt(withBreadcrumbs, index)
    }),
  }
}
