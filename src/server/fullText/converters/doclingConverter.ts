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

type JsonRecord = Record<string, unknown>
type DoclingItem = {item: JsonRecord; ref: string}
type DoclingPageSizes = Map<number, {height: number; width: number}>

const doclingLabel = 'Docling'
const doclingVersionTimeoutMs = 30_000
const doclingItemCollections = ['texts', 'tables', 'pictures', 'groups']

export const doclingConvertOptions = {
  do_chart_extraction: false,
  do_code_enrichment: false,
  do_formula_enrichment: false,
  do_ocr: true,
  do_pdf_heading_hierarchy: false,
  do_picture_classification: false,
  do_picture_description: false,
  do_table_structure: true,
  force_ocr: false,
  image_export_mode: 'referenced',
  images_scale: 2,
  include_images: true,
  include_page_images: false,
  md_compact_tables: false,
  md_page_break_placeholder: '',
  pdf_backend: 'docling_parse',
  pipeline: 'standard',
  table_mode: 'accurate',
  to_formats: ['md', 'json', 'html'],
}

const isRecord = (value: unknown): value is JsonRecord => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getRecordArray = (value: unknown): JsonRecord[] => {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

const getRefValue = (value: unknown): string | null => {
  return isRecord(value) && typeof value.$ref === 'string' ? value.$ref : null
}

const getDoclingItemIndex = (document: JsonRecord): Map<string, JsonRecord> => {
  return new Map(
    doclingItemCollections.flatMap((collection) => {
      return getRecordArray(document[collection]).map((item, index): [string, JsonRecord] => {
        return [typeof item.self_ref === 'string' ? item.self_ref : `#/${collection}/${index}`, item]
      })
    }),
  )
}

const getChildRefs = (item: JsonRecord): string[] => {
  return Array.isArray(item.children)
    ? item.children.map(getRefValue).filter((ref): ref is string => {
        return ref !== null
      })
    : []
}

const collectDoclingItems = ({
  index,
  refs,
  visited,
}: {
  index: Map<string, JsonRecord>
  refs: string[]
  visited: Set<string>
}): DoclingItem[] => {
  return refs.flatMap((ref) => {
    const item = index.get(ref)

    if (!item || visited.has(ref)) {
      return []
    }

    visited.add(ref)

    return [{item, ref}, ...collectDoclingItems({index, refs: getChildRefs(item), visited})]
  })
}

const getDoclingOrderedItems = (document: JsonRecord): DoclingItem[] => {
  const index = getDoclingItemIndex(document)
  const visited = new Set<string>()
  const rootRefs = ['body', 'furniture'].flatMap((root) => {
    return isRecord(document[root]) ? getChildRefs(document[root]) : []
  })
  const ordered = collectDoclingItems({index, refs: rootRefs, visited})
  const remaining = collectDoclingItems({index, refs: [...index.keys()], visited})

  return [...ordered, ...remaining].filter(({ref}) => {
    return !ref.startsWith('#/groups/')
  })
}

const getDoclingPageSizes = (document: JsonRecord): DoclingPageSizes => {
  const pages = isRecord(document.pages) ? Object.values(document.pages) : []

  return new Map(
    pages.filter(isRecord).flatMap((page): [number, {height: number; width: number}][] => {
      const size = isRecord(page.size) ? page.size : null

      return typeof page.page_no === 'number'
        && size
        && typeof size.width === 'number'
        && typeof size.height === 'number'
        ? [[page.page_no, {height: size.height, width: size.width}]]
        : []
    }),
  )
}

const getFirstProvenance = (item: JsonRecord): JsonRecord | null => {
  return getRecordArray(item.prov)[0] ?? null
}

const getDoclingPageNumber = (item: JsonRecord): number | null => {
  const provenance = getFirstProvenance(item)

  return typeof provenance?.page_no === 'number' ? provenance.page_no : null
}

const getNormalizedDoclingBoundingBox = ({
  bbox,
  size,
}: {
  bbox: JsonRecord
  size: {height: number; width: number}
}): FullTextBoundingBox | null => {
  const [left, top, right, bottom] = [bbox.l, bbox.t, bbox.r, bbox.b]
  const isBottomLeft = typeof bbox.coord_origin === 'string' && bbox.coord_origin.toUpperCase() === 'BOTTOMLEFT'

  return typeof left === 'number' && typeof top === 'number' && typeof right === 'number' && typeof bottom === 'number'
    ? [
        roundBoundingBoxValue(left / size.width),
        roundBoundingBoxValue((isBottomLeft ? size.height - top : top) / size.height),
        roundBoundingBoxValue(right / size.width),
        roundBoundingBoxValue((isBottomLeft ? size.height - bottom : bottom) / size.height),
      ]
    : null
}

const getDoclingBoundingBox = (item: JsonRecord, pageSizes: DoclingPageSizes): FullTextBoundingBox | null => {
  const provenance = getFirstProvenance(item)
  const page = getDoclingPageNumber(item)
  const size = page === null ? undefined : pageSizes.get(page)

  return provenance && isRecord(provenance.bbox) && size
    ? getNormalizedDoclingBoundingBox({bbox: provenance.bbox, size})
    : null
}

const getDoclingTableCellText = (cell: JsonRecord): string => {
  return (typeof cell.text === 'string' ? cell.text : '').replace(/\s+/g, ' ').trim().replaceAll('|', '\\|')
}

const getDoclingTableRows = (item: JsonRecord): string[][] => {
  const data = isRecord(item.data) ? item.data : null
  const grid = Array.isArray(data?.grid) ? data.grid : []

  return grid.map((row) => {
    return getRecordArray(row).map(getDoclingTableCellText)
  })
}

const getPipeTableRow = (cells: string[]): string => {
  return `| ${cells.join(' | ')} |`
}

const getDoclingTableText = (item: JsonRecord): string => {
  const [header, ...rows] = getDoclingTableRows(item)

  return header
    ? [
        getPipeTableRow(header),
        getPipeTableRow(
          header.map(() => {
            return '---'
          }),
        ),
        ...rows.map(getPipeTableRow),
      ].join('\n')
    : ''
}

const getDoclingItemText = (item: JsonRecord): string => {
  return typeof item.text === 'string' ? item.text : item.label === 'table' ? getDoclingTableText(item) : ''
}

const getDoclingRefTexts = (refs: unknown, index: Map<string, JsonRecord>): string[] => {
  return (Array.isArray(refs) ? refs : [])
    .map((value) => {
      const ref = getRefValue(value)
      const refItem = ref ? index.get(ref) : undefined

      return refItem && typeof refItem.text === 'string' ? refItem.text.trim() : ''
    })
    .filter((text) => {
      return text !== ''
    })
}

const getDoclingChildCaptionRefs = (item: JsonRecord, index: Map<string, JsonRecord>): JsonRecord[] => {
  return getChildRefs(item)
    .filter((ref) => {
      return index.get(ref)?.label === 'caption'
    })
    .map((ref) => {
      return {$ref: ref}
    })
}

const getDoclingCaptionRefs = (item: JsonRecord, index: Map<string, JsonRecord>): unknown[] => {
  const captionRefs = Array.isArray(item.captions) ? item.captions : []

  return captionRefs.length > 0 ? captionRefs : getDoclingChildCaptionRefs(item, index)
}

const getDoclingCaption = (item: JsonRecord, index: Map<string, JsonRecord>): string | null => {
  const caption = getDoclingRefTexts(getDoclingCaptionRefs(item, index), index).join(' ')

  return caption === '' ? null : caption
}

const getDoclingContainer = ({
  depth,
  index,
  item,
}: {
  depth: number
  index: Map<string, JsonRecord>
  item: JsonRecord
}): 'picture' | 'table' | null => {
  const parentRef = getRefValue(item.parent)
  const parent = parentRef ? index.get(parentRef) : undefined

  return !parentRef || !parent || depth > 32
    ? null
    : parentRef.startsWith('#/pictures/')
      ? 'picture'
      : parentRef.startsWith('#/tables/')
        ? 'table'
        : parentRef.startsWith('#/groups/')
          ? getDoclingContainer({depth: depth + 1, index, item: parent})
          : null
}

const getDoclingPartsOfType = ({
  index,
  refs,
  type,
}: {
  index: Map<string, JsonRecord>
  refs: unknown
  type: string
}): FullTextLayoutPart[] => {
  return getDoclingRefTexts(refs, index).map((text) => {
    return {text, type}
  })
}

const getDoclingLayoutParts = (item: JsonRecord, index: Map<string, JsonRecord>): FullTextLayoutPart[] | null => {
  return item.label === 'table'
    ? [
        ...getDoclingPartsOfType({index, refs: getDoclingCaptionRefs(item, index), type: 'table_caption'}),
        {text: getDoclingTableText(item), type: 'table_body'},
        ...getDoclingPartsOfType({index, refs: item.footnotes, type: 'table_footnote'}),
      ]
    : item.label === 'picture' || item.label === 'chart'
      ? [
          ...getDoclingPartsOfType({index, refs: getDoclingCaptionRefs(item, index), type: 'image_caption'}),
          ...getDoclingPartsOfType({index, refs: item.footnotes, type: 'image_footnote'}),
        ]
      : null
}

const getDoclingListMarker = (item: JsonRecord): string | null => {
  return item.label === 'list_item' && typeof item.marker === 'string' && item.marker.trim() !== ''
    ? item.marker.trim()
    : null
}

const getDoclingLayoutBlock = ({
  figureIndex,
  index,
  item,
  page,
  pageSizes,
}: {
  figureIndex: number | undefined
  index: Map<string, JsonRecord>
  item: JsonRecord
  page: number
  pageSizes: DoclingPageSizes
}): FullTextLayoutBlock => {
  const container = getDoclingContainer({depth: 0, index, item})
  const listMarker = getDoclingListMarker(item)
  const parts = getDoclingLayoutParts(item, index)

  return {
    bbox: getDoclingBoundingBox(item, pageSizes),
    ...(container ? {container} : {}),
    ...(figureIndex === undefined ? {} : {figureIndex}),
    ...(typeof item.level === 'number' && item.label === 'section_header' ? {level: item.level} : {}),
    ...(listMarker ? {listMarker} : {}),
    page,
    ...(parts ? {parts} : {}),
    text: getDoclingItemText(item),
    type: typeof item.label === 'string' ? item.label : 'unknown',
  }
}

const getDoclingLayout = ({
  figureIndexByRef,
  index,
  items,
  pageSizes,
}: {
  figureIndexByRef: Map<string, number>
  index: Map<string, JsonRecord>
  items: DoclingItem[]
  pageSizes: DoclingPageSizes
}): FullTextLayoutBlock[] => {
  return items.flatMap(({item, ref}) => {
    const page = getDoclingPageNumber(item)

    return page === null
      ? []
      : [getDoclingLayoutBlock({figureIndex: figureIndexByRef.get(ref), index, item, page, pageSizes})]
  })
}

const getDoclingImageUri = (item: JsonRecord): string | null => {
  const image = isRecord(item.image) ? item.image : null

  return typeof image?.uri === 'string' ? image.uri : null
}

const getDoclingFigureItems = (items: DoclingItem[], entries: ConverterZipEntries): DoclingItem[] => {
  return items.filter(({item, ref}) => {
    const uri = getDoclingImageUri(item)

    return ref.startsWith('#/pictures/') && uri !== null && entries[uri] !== undefined
  })
}

const getDoclingFigures = ({
  entries,
  figureItems,
  index,
  pageSizes,
}: {
  entries: ConverterZipEntries
  figureItems: DoclingItem[]
  index: Map<string, JsonRecord>
  pageSizes: DoclingPageSizes
}): FullTextParsedFigure[] => {
  return figureItems.map(({item}, figureIndex) => {
    const uri = getDoclingImageUri(item) ?? ''

    return {
      bbox: getDoclingBoundingBox(item, pageSizes),
      caption: getDoclingCaption(item, index),
      image: {bytes: entries[uri] as Uint8Array, extension: getZipFileExtension(uri)},
      index: figureIndex + 1,
      page: getDoclingPageNumber(item),
    }
  })
}

const getRootZipPath = (entries: ConverterZipEntries, extension: string): string | null => {
  const paths = Object.keys(entries).filter((path) => {
    return !path.includes('/') && path.toLowerCase().endsWith(`.${extension}`)
  })

  if (paths.length > 1) {
    throw new ConversionError(`Docling zip contains ${paths.length} .${extension} files, expected one`, undefined, true)
  }

  return paths[0] ?? null
}

const requireRootZipText = (entries: ConverterZipEntries, extension: string): string => {
  const path = getRootZipPath(entries, extension)
  const text = path ? getZipText(entries, path) : null

  if (text === null) {
    throw new ConversionError(`Docling zip is missing the .${extension} output`, undefined, true)
  }

  return text
}

export const parseDoclingZipEntries = ({
  converterVersion,
  entries,
}: {
  converterVersion: string
  entries: ConverterZipEntries
}): FullTextParsedConversion => {
  const markdown = requireRootZipText(entries, 'md')
  const document = parseConverterJson(requireRootZipText(entries, 'json'), doclingLabel)
  const htmlPath = getRootZipPath(entries, 'html')

  if (!isRecord(document)) {
    throw new ConversionError('Docling JSON output is not a document object', undefined, true)
  }

  const index = getDoclingItemIndex(document)
  const items = getDoclingOrderedItems(document)
  const pageSizes = getDoclingPageSizes(document)
  const figureItems = getDoclingFigureItems(items, entries)
  const figureIndexByRef = new Map(
    figureItems.map(({ref}, figureIndex): [string, number] => {
      return [ref, figureIndex + 1]
    }),
  )

  return {
    converterVersion,
    figures: getDoclingFigures({entries, figureItems, index, pageSizes}),
    html: htmlPath ? getZipText(entries, htmlPath) : null,
    layout: getDoclingLayout({figureIndexByRef, index, items, pageSizes}),
    markdown,
  }
}

export const getDoclingConverterVersion = (value: unknown): string => {
  const versions = isRecord(value)
    ? Object.entries(value)
        .filter(([name, version]) => {
          return name.startsWith('docling') && typeof version === 'string'
        })
        .sort(([left], [right]) => {
          return left.localeCompare(right)
        })
    : []

  if (
    !versions.some(([name]) => {
      return name === 'docling-serve'
    })
  ) {
    throw new ConversionError('Docling /version did not report a docling-serve version')
  }

  return versions
    .map(([name, version]) => {
      return `${name}=${String(version)}`
    })
    .join(' ')
}

export const fetchDoclingConverterVersion = async (baseURL: string): Promise<string> => {
  const response = await fetch(getConverterRoute(baseURL, '/version'), {
    signal: AbortSignal.timeout(doclingVersionTimeoutMs),
  }).catch((error: unknown) => {
    throw new ConversionError(
      `Docling /version request failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  })

  if (!response.ok) {
    throw new ConversionError(`Docling /version request failed: ${response.status} ${response.statusText}`)
  }

  return getDoclingConverterVersion(
    await response.json().catch(() => {
      return null
    }),
  )
}

const getDoclingRequestBody = (request: FullTextConverterRequest): string => {
  return JSON.stringify({
    options: doclingConvertOptions,
    sources: [
      {base64_string: Buffer.from(request.pdfBytes).toString('base64'), filename: request.fileName, kind: 'file'},
    ],
    target: {kind: 'zip'},
  })
}

const convertPdfWithDocling = async (request: FullTextConverterRequest): Promise<FullTextParsedConversion> => {
  const fileSizeMB = getFileSizeMB(request.pdfBytes)
  const converterVersion = await fetchDoclingConverterVersion(request.baseURL)
  const response = await sendConverterRequest({
    fileSizeMB,
    init: {body: getDoclingRequestBody(request), headers: {'Content-Type': 'application/json'}, method: 'POST'},
    label: doclingLabel,
    timeoutMs: request.timeoutMs,
    url: getConverterRoute(request.baseURL, '/v1/convert/source'),
  })

  if (!response.ok) {
    throw await getConverterResponseError({fileSizeMB, label: doclingLabel, response})
  }

  const bytes = await readConverterBytes({fileSizeMB, label: doclingLabel, response, timeoutMs: request.timeoutMs})

  return parseDoclingZipEntries({converterVersion, entries: readConverterZip(bytes, doclingLabel)})
}

export const doclingConverter: FullTextConverter = {
  convert: convertPdfWithDocling,
  kind: 'docling',
  options: doclingConvertOptions,
}
