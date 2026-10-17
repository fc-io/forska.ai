import {
  getFrontMatterLineDropReason,
  getHeadingKey,
  getHeadingNumberDepth,
  isAuthorBlockText,
} from './canonicalFullTextPatterns.ts'
import {
  type CanonicalBodyUnit,
  type CanonicalDropReason,
  type CanonicalHeadingUnit,
  type CanonicalUnit,
  type CanonicalUnitSequence,
} from './canonicalFullTextUnits.ts'

export type CanonicalBodySequence = {drops: CanonicalDropReason[]; units: CanonicalBodyUnit[]}

type FrontMatterState = {
  drops: CanonicalDropReason[]
  inAuthorRun: boolean
  inFrontContent: boolean
  units: CanonicalBodyUnit[]
}

const frontMatterMaxPage = 2

const frontContentHeadingKeys = new Set([
  'abstract',
  'graphicalabstract',
  'highlights',
  'keypoints',
  'keyword',
  'keywords',
  'summary',
])

const frontMetadataHeadingKeys = new Set([
  'articlehistory',
  'articleinfo',
  'articleinformation',
  'citation',
  'copyright',
  'correspondence',
  'editedby',
  'openaccess',
  'reviewedby',
])

const bodyHeadingKeys = new Set([
  'background',
  'discussion',
  'introduction',
  'materialsandmethods',
  'methods',
  'methodology',
  'patientsandmethods',
  'results',
])

const isFrontMatterHeadingKey = (key: string): boolean => {
  return frontContentHeadingKeys.has(key) || frontMetadataHeadingKeys.has(key)
}

const isStrongBodyHeading = (unit: CanonicalUnit): boolean => {
  return (
    unit.kind === 'heading'
    && (getHeadingNumberDepth(unit.text) !== null || bodyHeadingKeys.has(getHeadingKey(unit.text)))
  )
}

const isFrontMatterHeadingBefore = (unit: CanonicalUnit, index: number, strongBodyIndex: number): boolean => {
  return (
    unit.kind === 'heading'
    && unit.page <= frontMatterMaxPage
    && (strongBodyIndex === -1 || index < strongBodyIndex)
    && isFrontMatterHeadingKey(getHeadingKey(unit.text))
  )
}

const getBodyStartIndex = (units: CanonicalUnit[]): number => {
  const strongBodyIndex = units.findIndex(isStrongBodyHeading)
  const lastFrontMatterHeadingIndex = units.findLastIndex((unit, index) => {
    return isFrontMatterHeadingBefore(unit, index, strongBodyIndex)
  })
  const bodyStartIndex = units.findIndex((unit, index) => {
    return (
      index > lastFrontMatterHeadingIndex
      && unit.kind === 'heading'
      && !isFrontMatterHeadingKey(getHeadingKey(unit.text))
    )
  })

  return bodyStartIndex === -1 ? units.length : bodyStartIndex
}

const dropFrontUnit = (
  state: FrontMatterState,
  reason: CanonicalDropReason,
  inAuthorRun: boolean,
): FrontMatterState => {
  return {...state, drops: [...state.drops, reason], inAuthorRun}
}

const keepUnit = (state: FrontMatterState, unit: CanonicalBodyUnit): FrontMatterState => {
  return {...state, inAuthorRun: false, units: [...state.units, unit]}
}

const applyFrontHeading = (state: FrontMatterState, unit: CanonicalHeadingUnit): FrontMatterState => {
  const isFrontMatterHeading = isFrontMatterHeadingKey(getHeadingKey(unit.text))

  return {
    ...dropFrontUnit(state, isFrontMatterHeading ? 'front_matter' : 'title', !isFrontMatterHeading),
    inFrontContent: isFrontMatterHeading,
  }
}

const getFrontTextDropReason = (state: FrontMatterState, unit: CanonicalBodyUnit): CanonicalDropReason | null => {
  const text = unit.kind === 'paragraph' || unit.kind === 'list_item' ? unit.text : null
  const lineReason = text === null ? null : getFrontMatterLineDropReason(text)

  return lineReason ?? (text !== null && state.inAuthorRun && isAuthorBlockText(text) ? 'author_line' : null)
}

const applyFrontContent = ({
  captionedFigureIndices,
  state,
  unit,
}: {
  captionedFigureIndices: Set<number>
  state: FrontMatterState
  unit: CanonicalBodyUnit
}): FrontMatterState => {
  const textDropReason = getFrontTextDropReason(state, unit)
  const isFloat = unit.kind === 'figure' || unit.kind === 'table'
  const isUncaptionedFigure = unit.kind === 'figure' && !captionedFigureIndices.has(unit.figureIndex)

  return textDropReason
    ? dropFrontUnit(state, textDropReason, state.inAuthorRun)
    : isUncaptionedFigure
      ? dropFrontUnit(state, 'front_matter', state.inAuthorRun)
      : state.inFrontContent && !isFloat
        ? dropFrontUnit(state, 'front_matter', false)
        : keepUnit(state, unit)
}

const applyFrontUnit = ({
  captionedFigureIndices,
  state,
  unit,
}: {
  captionedFigureIndices: Set<number>
  state: FrontMatterState
  unit: CanonicalBodyUnit
}): FrontMatterState => {
  return unit.kind === 'heading'
    ? applyFrontHeading(state, unit)
    : applyFrontContent({captionedFigureIndices, state, unit})
}

const applyUnit = ({
  bodyStartIndex,
  captionedFigureIndices,
  index,
  state,
  unit,
}: {
  bodyStartIndex: number
  captionedFigureIndices: Set<number>
  index: number
  state: FrontMatterState
  unit: CanonicalUnit
}): FrontMatterState => {
  const isFront = index < bodyStartIndex && unit.page <= frontMatterMaxPage

  return unit.kind === 'title'
    ? {...dropFrontUnit(state, 'title', isFront), inFrontContent: false}
    : isFront
      ? applyFrontUnit({captionedFigureIndices, state, unit})
      : keepUnit(state, unit)
}

export const dropFrontMatter = (
  sequence: CanonicalUnitSequence,
  captionedFigureIndices: Set<number>,
): CanonicalBodySequence => {
  const bodyStartIndex = getBodyStartIndex(sequence.units)
  const initialState: FrontMatterState = {drops: sequence.drops, inAuthorRun: false, inFrontContent: false, units: []}
  const finalState = sequence.units.reduce((state, unit, index) => {
    return applyUnit({bodyStartIndex, captionedFigureIndices, index, state, unit})
  }, initialState)

  return {drops: finalState.drops, units: finalState.units}
}
