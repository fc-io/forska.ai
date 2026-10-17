import {type CanonicalBodySequence, dropFrontMatter} from './canonicalFullTextFrontMatter.ts'
import {getHeadingKey, getHeadingNumberDepth, isCorrespondenceText} from './canonicalFullTextPatterns.ts'
import {
  type CanonicalBodyUnit,
  type CanonicalDropReason,
  type CanonicalHeadingUnit,
  type CanonicalUnitSequence,
} from './canonicalFullTextUnits.ts'

export type CanonicalBreadcrumbHeading = {breadcrumb: string[]; kind: 'heading'; page: number}

export type CanonicalRenderUnit = Exclude<CanonicalBodyUnit, CanonicalHeadingUnit> | CanonicalBreadcrumbHeading

type DroppedSection = {depth: number; reason: CanonicalDropReason}

type SectionState = {
  drops: CanonicalDropReason[]
  droppedSection: DroppedSection | null
  referencesSeen: boolean
  supplementaryDepth: number | null
  units: CanonicalBodyUnit[]
}

type BreadcrumbState = {stack: {depth: number; text: string}[]; units: CanonicalRenderUnit[]}

const supplementaryLinkMaxLength = 400
const referenceFragmentMaxLength = 400

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

export const getHeadingDepth = (unit: CanonicalHeadingUnit): number => {
  return getHeadingNumberDepth(unit.text) ?? unit.converterDepth ?? 1
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

const getTextUnitDropReason = (unit: CanonicalBodyUnit, state: SectionState): CanonicalDropReason | null => {
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

const keepUnit = (state: SectionState, unit: CanonicalBodyUnit): SectionState => {
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

const applyContentUnit = (state: SectionState, unit: CanonicalBodyUnit): SectionState => {
  const isFloat = unit.kind === 'figure' || unit.kind === 'table'
  const textDropReason = getTextUnitDropReason(unit, state)

  return state.droppedSection && !isFloat
    ? dropUnit(state, state.droppedSection.reason)
    : textDropReason
      ? dropUnit(state, textDropReason)
      : keepUnit(state, unit)
}

const applySectionRules = (sequence: CanonicalBodySequence): CanonicalBodySequence => {
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

const applyBreadcrumb = (state: BreadcrumbState, unit: CanonicalBodyUnit): BreadcrumbState => {
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
