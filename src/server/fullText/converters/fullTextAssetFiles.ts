import {mkdir, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {resolveRuntimeWritablePath} from '../../utils/runtimeWritablePath.ts'
import {type FullTextFigure, type FullTextLayoutBlock, type FullTextParsedFigure} from './fullTextConverterTypes.ts'

export const fullTextAssetsRelativeRoot = 'assets/full-text-assets'

const toSafePathSegment = (value: string): string => {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export const getFullTextAssetsRelativeDir = (articleId: string): string => {
  return `${fullTextAssetsRelativeRoot}/${toSafePathSegment(articleId)}`
}

const writeFigureFile = async ({
  absoluteDir,
  figure,
  relativeDir,
}: {
  absoluteDir: string
  figure: FullTextParsedFigure
  relativeDir: string
}): Promise<FullTextFigure> => {
  const fileName = `fig-${figure.index}.${figure.image.extension}`

  await writeFile(join(absoluteDir, fileName), figure.image.bytes)

  return {
    bbox: figure.bbox,
    caption: figure.caption,
    imagePath: `${relativeDir}/${fileName}`,
    index: figure.index,
    page: figure.page,
  }
}

export const writeFullTextAssetFiles = async ({
  articleId,
  cwd,
  figures,
  layout,
}: {
  articleId: string
  cwd?: string
  figures: FullTextParsedFigure[]
  layout: FullTextLayoutBlock[]
}): Promise<{figures: FullTextFigure[]; layoutPath: string}> => {
  const relativeDir = getFullTextAssetsRelativeDir(articleId)
  const absoluteDir = resolveRuntimeWritablePath({cwd, pathValue: relativeDir})
  const layoutPath = `${relativeDir}/layout.json`

  await rm(absoluteDir, {force: true, recursive: true})
  await mkdir(absoluteDir, {recursive: true})
  await writeFile(join(absoluteDir, 'layout.json'), JSON.stringify(layout))

  const writtenFigures = await Promise.all(
    figures.map((figure) => {
      return writeFigureFile({absoluteDir, figure, relativeDir})
    }),
  )

  return {figures: writtenFigures, layoutPath}
}
