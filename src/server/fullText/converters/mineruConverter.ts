import {ConversionError} from './conversionError.ts'
import {
  type ConverterZipEntries,
  getConverterResponseError,
  getConverterRoute,
  getFileSizeMB,
  getZipFileExtension,
  getZipText,
  parseConverterJson,
  readConverterBytes,
  readConverterZip,
  roundBoundingBoxValue,
  sendConverterRequest,
} from './converterHttp.ts'
import {
  type FullTextBoundingBox,
  type FullTextConverter,
  type FullTextConverterRequest,
  type FullTextLayoutBlock,
  type FullTextLayoutPart,
  type FullTextParsedConversion,
  type FullTextParsedFigure,
} from './fullTextConverterTypes.ts'

type MineruBlock = {
  bbox: unknown
  content: unknown
  continues_prev?: unknown
  image_path?: unknown
  level?: unknown
  type: string
}
type MineruPage = {blocks: MineruBlock[]; page_idx: number}
type MineruPageBlock = {block: MineruBlock; page: number}

const mineruLabel = 'MinerU'
const mineruFigureBlockTypes = ['image', 'chart']
const mineruVisualBlockTypes = ['image', 'chart', 'table', 'code']
const mineruMaxWaitSeconds = 3600
const mineruWaitMarginSeconds = 15

export const mineruConvertOptions = {
  ocr_mode: 'auto',
  output_formats: ['markdown', 'middle_json', 'zip'],
  page_range: '',
  tier: 'standard',
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getMineruBlock = (value: unknown): MineruBlock | null => {
  return isRecord(value) && typeof value.type === 'string'
    ? {
        bbox: value.bbox,
        content: value.content,
        continues_prev: value.continues_prev,
        image_path: value.image_path,
        level: value.level,
        type: value.type,
      }
    : null
}

const getMineruPage = (value: unknown): MineruPage | null => {
  return isRecord(value) && typeof value.page_idx === 'number' && Array.isArray(value.blocks)
    ? {
        blocks: value.blocks.map(getMineruBlock).filter((block): block is MineruBlock => {
          return block !== null
        }),
        page_idx: value.page_idx,
      }
    : null
}

const getMineruBoundingBox = (value: unknown): FullTextBoundingBox | null => {
  return Array.isArray(value)
    && value.length === 4
    && value.every((entry) => {
      return typeof entry === 'number' && Number.isFinite(entry)
    })
    ? [
        roundBoundingBoxValue(value[0] as number),
        roundBoundingBoxValue(value[1] as number),
        roundBoundingBoxValue(value[2] as number),
        roundBoundingBoxValue(value[3] as number),
      ]
    : null
}

const isMineruSubBlock = (value: unknown): boolean => {
  return isRecord(value) && Array.isArray(value.bbox)
}

const getMineruSpanText = (entry: Record<string, unknown>): string => {
  const text = getMineruContentText(entry.content)

  return entry.type === 'equation_inline' && text.trim() !== '' ? `$${text.trim()}$` : text
}

const getMineruContentText = (content: unknown): string => {
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((entry) => {
            return isRecord(entry) ? getMineruSpanText(entry) : ''
          })
          .filter((text) => {
            return text !== ''
          })
          .join(content.some(isMineruSubBlock) ? '\n' : '')
      : ''
}

const getMineruSubBlocks = (block: MineruBlock): MineruBlock[] => {
  return Array.isArray(block.content)
    ? block.content.map(getMineruBlock).filter((entry): entry is MineruBlock => {
        return entry !== null
      })
    : []
}

const getMineruCaption = (block: MineruBlock): string | null => {
  const caption = getMineruSubBlocks(block)
    .filter((entry) => {
      return entry.type.endsWith('_caption')
    })
    .map((entry) => {
      return getMineruContentText(entry.content).trim()
    })
    .filter((text) => {
      return text !== ''
    })
    .join(' ')

  return caption === '' ? null : caption
}

const getMineruImagePath = (block: MineruBlock): string | null => {
  const body = getMineruSubBlocks(block).find((entry) => {
    return entry.type.endsWith('_body') && typeof entry.image_path === 'string' && entry.image_path !== ''
  })

  return typeof body?.image_path === 'string' ? body.image_path : null
}

const getMineruPageBlocks = (pages: MineruPage[]): MineruPageBlock[] => {
  return pages.flatMap((page) => {
    return page.blocks.map((block) => {
      return {block, page: page.page_idx + 1}
    })
  })
}

const getMineruListParts = (block: MineruBlock, depth: number): FullTextLayoutPart[] => {
  return getMineruSubBlocks(block).flatMap((entry) => {
    return entry.type === 'list'
      ? getMineruListParts(entry, depth + 1)
      : [{...(depth > 0 ? {depth} : {}), text: getMineruContentText(entry.content), type: entry.type}]
  })
}

const getMineruVisualParts = (block: MineruBlock): FullTextLayoutPart[] => {
  return getMineruSubBlocks(block).map((entry) => {
    return {text: getMineruContentText(entry.content), type: entry.type}
  })
}

const getMineruLayoutParts = (block: MineruBlock): FullTextLayoutPart[] | null => {
  return block.type === 'list'
    ? getMineruListParts(block, 0)
    : mineruVisualBlockTypes.includes(block.type)
      ? getMineruVisualParts(block)
      : null
}

const getMineruLayoutBlock = ({
  figureIndex,
  pageBlock,
}: {
  figureIndex: number | undefined
  pageBlock: MineruPageBlock
}): FullTextLayoutBlock => {
  const {block, page} = pageBlock
  const parts = getMineruLayoutParts(block)

  return {
    bbox: getMineruBoundingBox(block.bbox),
    ...(block.continues_prev === true ? {continuesPrevious: true as const} : {}),
    ...(figureIndex === undefined ? {} : {figureIndex}),
    ...(typeof block.level === 'number' ? {level: block.level} : {}),
    page,
    ...(parts ? {parts} : {}),
    text: getMineruContentText(block.content),
    type: block.type,
  }
}

const getMineruLayout = (
  pageBlocks: MineruPageBlock[],
  figureIndexByBlock: Map<MineruBlock, number>,
): FullTextLayoutBlock[] => {
  return pageBlocks.map((pageBlock) => {
    return getMineruLayoutBlock({figureIndex: figureIndexByBlock.get(pageBlock.block), pageBlock})
  })
}

const getMineruFigureBlocks = (pageBlocks: MineruPageBlock[], entries: ConverterZipEntries): MineruPageBlock[] => {
  return pageBlocks.filter(({block}) => {
    const imagePath = getMineruImagePath(block)

    return mineruFigureBlockTypes.includes(block.type) && imagePath !== null && entries[imagePath] !== undefined
  })
}

const getMineruFigures = (figureBlocks: MineruPageBlock[], entries: ConverterZipEntries): FullTextParsedFigure[] => {
  return figureBlocks.map(({block, page}, index) => {
    const imagePath = getMineruImagePath(block) ?? ''

    return {
      bbox: getMineruBoundingBox(block.bbox),
      caption: getMineruCaption(block),
      image: {bytes: entries[imagePath] as Uint8Array, extension: getZipFileExtension(imagePath)},
      index: index + 1,
      page,
    }
  })
}

const getMineruProducerVersion = (middleJson: Record<string, unknown>): string => {
  const metadata = isRecord(middleJson.metadata) ? middleJson.metadata : null
  const producer = metadata && isRecord(metadata.producer) ? metadata.producer : null
  const version = producer && producer.name === 'mineru' && typeof producer.version === 'string' ? producer.version : ''

  if (version.trim() === '') {
    throw new ConversionError('MinerU middle_json.json is missing metadata.producer.version', undefined, true)
  }

  return version.trim()
}

const requireZipText = (entries: ConverterZipEntries, path: string): string => {
  const text = getZipText(entries, path)

  if (text === null) {
    throw new ConversionError(`MinerU zip is missing ${path}`, undefined, true)
  }

  return text
}

export const parseMineruZipEntries = (entries: ConverterZipEntries): FullTextParsedConversion => {
  const markdown = requireZipText(entries, 'markdown.md')
  const middleJson = parseConverterJson(requireZipText(entries, 'middle_json.json'), mineruLabel)

  if (!isRecord(middleJson) || !Array.isArray(middleJson.pages)) {
    throw new ConversionError('MinerU middle_json.json has no pages array', undefined, true)
  }

  const pageBlocks = getMineruPageBlocks(
    middleJson.pages.map(getMineruPage).filter((page): page is MineruPage => {
      return page !== null
    }),
  )
  const figureBlocks = getMineruFigureBlocks(pageBlocks, entries)
  const figureIndexByBlock = new Map(
    figureBlocks.map(({block}, index): [MineruBlock, number] => {
      return [block, index + 1]
    }),
  )

  return {
    converterVersion: getMineruProducerVersion(middleJson),
    figures: getMineruFigures(figureBlocks, entries),
    html: null,
    layout: getMineruLayout(pageBlocks, figureIndexByBlock),
    markdown,
  }
}

const getMineruWaitTimeoutSeconds = (timeoutMs: number): number => {
  return Math.max(1, Math.min(mineruMaxWaitSeconds, Math.floor(timeoutMs / 1000) - mineruWaitMarginSeconds))
}

export const getMineruFileParseUrl = ({baseURL, timeoutMs}: {baseURL: string; timeoutMs: number}): string => {
  const params = new URLSearchParams([
    ['tier', mineruConvertOptions.tier],
    ['ocr_mode', mineruConvertOptions.ocr_mode],
    ['page_range', mineruConvertOptions.page_range],
    ...mineruConvertOptions.output_formats.map((format): [string, string] => {
      return ['output_formats', format]
    }),
    ['response_format', 'zip'],
    ['wait_timeout', String(getMineruWaitTimeoutSeconds(timeoutMs))],
  ])

  return getConverterRoute(baseURL, `/v1/file_parse?${params.toString()}`)
}

const cancelMineruTask = async ({baseURL, response}: {baseURL: string; response: Response}): Promise<string> => {
  const payload = (await response.json().catch(() => {
    return null
  })) as unknown
  const taskId = isRecord(payload) && typeof payload.task_id === 'string' ? payload.task_id : null

  if (taskId) {
    await fetch(getConverterRoute(baseURL, `/v1/tasks/${encodeURIComponent(taskId)}`), {method: 'DELETE'}).catch(() => {
      return null
    })
  }

  return taskId ?? 'unknown'
}

const getMineruZipEntries = async ({
  request,
  response,
}: {
  request: FullTextConverterRequest
  response: Response
}): Promise<ConverterZipEntries> => {
  const fileSizeMB = getFileSizeMB(request.pdfBytes)
  const bytes = await readConverterBytes({fileSizeMB, label: mineruLabel, response, timeoutMs: request.timeoutMs})

  return readConverterZip(bytes, mineruLabel)
}

const getMineruPendingError = async ({
  request,
  response,
}: {
  request: FullTextConverterRequest
  response: Response
}): Promise<never> => {
  const taskId = await cancelMineruTask({baseURL: request.baseURL, response})

  throw new ConversionError(
    `MinerU conversion did not finish within ${getMineruWaitTimeoutSeconds(request.timeoutMs)}s (task ${taskId} canceled, file: ${getFileSizeMB(request.pdfBytes)}MB)`,
  )
}

const convertPdfWithMineru = async (request: FullTextConverterRequest): Promise<FullTextParsedConversion> => {
  const fileSizeMB = getFileSizeMB(request.pdfBytes)
  const form = new FormData()

  form.append('files', new File([request.pdfBytes], request.fileName, {type: 'application/pdf'}))

  const response = await sendConverterRequest({
    fileSizeMB,
    init: {body: form, method: 'POST'},
    label: mineruLabel,
    timeoutMs: request.timeoutMs,
    url: getMineruFileParseUrl({baseURL: request.baseURL, timeoutMs: request.timeoutMs}),
  })

  if (response.status === 202) {
    return getMineruPendingError({request, response})
  }

  if (!response.ok) {
    throw await getConverterResponseError({fileSizeMB, label: mineruLabel, response})
  }

  return parseMineruZipEntries(await getMineruZipEntries({request, response}))
}

export const mineruConverter: FullTextConverter = {
  convert: convertPdfWithMineru,
  kind: 'mineru',
  options: mineruConvertOptions,
}
