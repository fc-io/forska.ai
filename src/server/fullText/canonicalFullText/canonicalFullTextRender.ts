import {type CanonicalFullTextAsset, type FullTextFigureMode} from '../canonicalFullText.ts'
import {type CanonicalRenderUnit} from './canonicalFullTextSections.ts'
import {getPipeTableLines} from './canonicalFullTextTables.ts'
import {
  type CanonicalCodeUnit,
  type CanonicalEquationUnit,
  type CanonicalFigureUnit,
  type CanonicalListItemUnit,
  type CanonicalTableUnit,
  normalizeInlineText,
} from './canonicalFullTextUnits.ts'

type RenderedBlocks = {blocks: string[]; previousKind: CanonicalRenderUnit['kind'] | null}

const maxListDepth = 6
const listMarkerPattern = /^(?:[-–•·▪◦‣∙*]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|\([ivxlcdm]+\))\s/

const getTextLines = (text: string): string[] => {
  return text
    .split('\n')
    .map(normalizeInlineText)
    .filter((line) => {
      return line !== ''
    })
}

const getCodeLines = (text: string): string[] => {
  return text
    .split('\n')
    .map((line) => {
      return line.replace(/[^\S\n]+$/, '')
    })
    .filter((line) => {
      return line.trim() !== ''
    })
}

const renderListItem = (unit: CanonicalListItemUnit): string => {
  const indent = '  '.repeat(Math.min(unit.depth, maxListDepth))
  const marker = unit.marker ?? (listMarkerPattern.test(unit.text) ? null : '-')
  const hasMarker = marker === null || unit.text.startsWith(`${marker} `)

  return hasMarker ? `${indent}${unit.text}` : `${indent}${marker} ${unit.text}`
}

const renderTable = (unit: CanonicalTableUnit): string => {
  const bodyLines = unit.rows ? getPipeTableLines(unit.rows) : getTextLines(unit.bodyText ?? '')

  return [...unit.captions, ...bodyLines, ...unit.footnotes].join('\n')
}

const renderEquation = (unit: CanonicalEquationUnit): string => {
  const lines = getTextLines(unit.text)

  return (unit.latex ? ['$$', ...lines, '$$'] : lines).join('\n')
}

const renderCode = (unit: CanonicalCodeUnit): string => {
  return [...unit.captions, '```', ...getCodeLines(unit.body), '```', ...unit.footnotes].join('\n')
}

const getFigureLines = ({
  asset,
  figureMode,
}: {
  asset: CanonicalFullTextAsset
  figureMode: FullTextFigureMode
}): string[] => {
  const caption = normalizeInlineText(asset.caption ?? '')
  const heading = caption === '' ? `Figure ${asset.index}` : `Figure ${asset.index}: ${caption}`

  return figureMode === 'native_images' ? [heading, `[figure:${asset.index}]`] : [heading]
}

const appendBlock = (state: RenderedBlocks, kind: CanonicalRenderUnit['kind'], block: string): RenderedBlocks => {
  return {...state, blocks: [...state.blocks, block], previousKind: kind}
}

const appendListItem = (state: RenderedBlocks, unit: CanonicalListItemUnit): RenderedBlocks => {
  const line = renderListItem(unit)
  const lastBlock = state.blocks.at(-1)

  return state.previousKind === 'list_item' && lastBlock !== undefined
    ? {...state, blocks: [...state.blocks.slice(0, -1), `${lastBlock}\n${line}`]}
    : appendBlock(state, 'list_item', line)
}

type RenderContext = {
  assetByIndex: Map<number, CanonicalFullTextAsset>
  figureMode: FullTextFigureMode
  state: RenderedBlocks
}

type UnitRenderers = {
  [Kind in CanonicalRenderUnit['kind']]: (
    unit: Extract<CanonicalRenderUnit, {kind: Kind}>,
    context: RenderContext,
  ) => RenderedBlocks
}

const appendFigure = (unit: CanonicalFigureUnit, {assetByIndex, figureMode, state}: RenderContext): RenderedBlocks => {
  const asset = assetByIndex.get(unit.figureIndex) as CanonicalFullTextAsset

  return appendBlock(state, unit.kind, getFigureLines({asset, figureMode}).join('\n'))
}

const unitRenderers: UnitRenderers = {
  code: (unit, {state}) => {
    return appendBlock(state, unit.kind, renderCode(unit))
  },
  equation: (unit, {state}) => {
    return appendBlock(state, unit.kind, renderEquation(unit))
  },
  figure: appendFigure,
  heading: (unit, {state}) => {
    return appendBlock(state, unit.kind, `## ${unit.breadcrumb.join(' > ')}`)
  },
  list_item: (unit, {state}) => {
    return appendListItem(state, unit)
  },
  paragraph: (unit, {state}) => {
    return appendBlock(state, unit.kind, unit.text)
  },
  table: (unit, {state}) => {
    return appendBlock(state, unit.kind, renderTable(unit))
  },
}

const renderUnit = (unit: CanonicalRenderUnit, context: RenderContext): RenderedBlocks => {
  const renderer = unitRenderers[unit.kind] as (unit: CanonicalRenderUnit, context: RenderContext) => RenderedBlocks

  return renderer(unit, context)
}

const normalizeBlock = (block: string): string => {
  return block
    .normalize('NFC')
    .split('\n')
    .map((line) => {
      return line.replace(/[^\S\n]+$/, '')
    })
    .filter((line) => {
      return line.trim() !== ''
    })
    .join('\n')
}

export const renderCanonicalUnits = ({
  assetByIndex,
  figureMode,
  units,
}: {
  assetByIndex: Map<number, CanonicalFullTextAsset>
  figureMode: FullTextFigureMode
  units: CanonicalRenderUnit[]
}): {text: string} => {
  const rendered = units.reduce(
    (state, unit) => {
      return renderUnit(unit, {assetByIndex, figureMode, state})
    },
    {blocks: [], previousKind: null} as RenderedBlocks,
  )
  const blocks = rendered.blocks.map(normalizeBlock).filter((block) => {
    return block !== ''
  })

  return {text: blocks.length > 0 ? `${blocks.join('\n\n')}\n` : ''}
}
