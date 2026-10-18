import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {
  buildCanonicalFullText,
  type CanonicalFullTextAsset,
  type FullTextFigureMode,
} from '../fullText/canonicalFullText.ts'
import type {FullTextConverterKind, FullTextLayoutBlock} from '../fullText/converters/fullTextConverterTypes.ts'

export type CanonicalFixtureName = 'arxiv-2111.06377' | 'frontiers-fmed-2023-1283512' | 'nejm-style'

const fixtureDirectory = join(import.meta.dir, '..', 'fullText', 'fixtures', 'canonical')

export const readCanonicalFixtureFile = (fileName: string): string => {
  return readFileSync(join(fixtureDirectory, fileName), 'utf8')
}

export const getCanonicalFixtureAssets = (name: CanonicalFixtureName, converterKind: FullTextConverterKind) => {
  return JSON.parse(readCanonicalFixtureFile(`${name}.${converterKind}.assets.json`)) as CanonicalFullTextAsset[]
}

export const buildCanonicalFixture = ({
  assets,
  converterKind,
  figureMode,
  name,
}: {
  assets?: CanonicalFullTextAsset[]
  converterKind: FullTextConverterKind
  figureMode: FullTextFigureMode
  name: CanonicalFixtureName
}) => {
  const layoutFile = JSON.parse(readCanonicalFixtureFile(`${name}.${converterKind}.layout.json`)) as {
    blocks: FullTextLayoutBlock[]
  }

  return buildCanonicalFullText({
    assets: assets ?? getCanonicalFixtureAssets(name, converterKind),
    converterKind,
    figureMode,
    layout: layoutFile.blocks,
  })
}
