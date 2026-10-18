import {type CanonicalFullTextAsset} from '../canonicalFullText.ts'
import {type FullTextLayoutBlock, type FullTextLayoutPart} from '../converters/fullTextConverterTypes.ts'

export const stripNulCharacters = (value: string): string => {
  return value.replaceAll('\u0000', '')
}

const stripPartNulCharacters = (part: FullTextLayoutPart): FullTextLayoutPart => {
  return {...part, text: stripNulCharacters(part.text)}
}

const stripBlockNulCharacters = (block: FullTextLayoutBlock): FullTextLayoutBlock => {
  return {
    ...block,
    text: stripNulCharacters(block.text),
    ...(block.listMarker === undefined ? {} : {listMarker: stripNulCharacters(block.listMarker)}),
    ...(block.parts === undefined ? {} : {parts: block.parts.map(stripPartNulCharacters)}),
  }
}

export const stripLayoutNulCharacters = (layout: FullTextLayoutBlock[]): FullTextLayoutBlock[] => {
  return layout.map(stripBlockNulCharacters)
}

export const stripAssetNulCharacters = (assets: CanonicalFullTextAsset[]): CanonicalFullTextAsset[] => {
  return assets.map((asset) => {
    return asset.caption === null ? asset : {...asset, caption: stripNulCharacters(asset.caption)}
  })
}
