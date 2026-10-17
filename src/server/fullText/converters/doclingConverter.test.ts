import {readFileSync} from 'node:fs'

import {afterEach, expect, test} from 'bun:test'
import {strToU8, zipSync} from 'fflate'

import {ConversionError} from './conversionError.ts'
import {
  doclingConverter,
  doclingConvertOptions,
  getDoclingConverterVersion,
  parseDoclingZipEntries,
} from './doclingConverter.ts'

const documentText = readFileSync(new URL('./fixtures/doclingDocument.json', import.meta.url), 'utf8')
const pictureBytes = new Uint8Array([137, 80, 78, 71, 1, 2])
const doclingVersion = {
  docling: '2.140.0',
  'docling-core': '2.101.1',
  'docling-serve': '1.37.0',
  plaform: 'macOS-26.5.2-arm64-arm-64bit',
  python: 'cpython-312 (3.12.13)',
}
const servers: {stop: (force?: boolean) => void}[] = []

const getDoclingEntries = () => {
  return {
    'artifacts/': new Uint8Array(),
    'artifacts/image_000000_abc.png': pictureBytes,
    'paper.html': strToU8('<html><body><h2>1 Introduction</h2></body></html>'),
    'paper.json': strToU8(documentText),
    'paper.md': strToU8('## 1 Introduction\n\n![Image](artifacts/image_000000_abc.png)\n'),
  }
}

const startDoclingServer = (handler: (request: Request) => Response | Promise<Response>) => {
  const server = globalThis.Bun.serve({fetch: handler, port: 0})
  servers.push(server)

  return server.url.toString().replace(/\/$/, '')
}

afterEach(() => {
  servers.splice(0).forEach((server) => {
    server.stop(true)
  })
})

test('Docling zip parsing follows body reading order, normalises bboxes and resolves caption refs', () => {
  const parsed = parseDoclingZipEntries({converterVersion: 'docling-serve=1.37.0', entries: getDoclingEntries()})

  expect(parsed.converterVersion).toBe('docling-serve=1.37.0')
  expect(parsed.markdown).toContain('## 1 Introduction')
  expect(parsed.html).toContain('<h2>1 Introduction</h2>')
  expect(
    parsed.layout.map((block) => {
      return block.type
    }),
  ).toEqual(['section_header', 'list_item', 'picture', 'caption', 'table', 'page_header', 'picture'])
  expect(parsed.layout[0]).toEqual({
    bbox: [0.1, 0.05, 0.3333, 0.0688],
    level: 1,
    page: 3,
    text: '1 Introduction',
    type: 'section_header',
  })
  expect(parsed.layout[1]?.listMarker).toBe('-')
  expect(parsed.layout[2]).toMatchObject({
    figureIndex: 1,
    parts: [{text: 'FIGURE 1 PRISMA flow diagram of study selection.', type: 'image_caption'}],
    type: 'picture',
  })
  expect(parsed.layout[3]).toMatchObject({container: 'picture', type: 'caption'})
  expect(parsed.layout[4]?.text).toBe('| Study | Country |\n| --- | --- |\n| Xia 2023 | China |')
  expect(parsed.layout[4]?.parts).toEqual([
    {text: '| Study | Country |\n| --- | --- |\n| Xia 2023 | China |', type: 'table_body'},
  ])
  expect(parsed.layout[6]?.figureIndex).toBeUndefined()
  expect(parsed.figures).toEqual([
    {
      bbox: [0.1, 0.125, 0.5, 0.375],
      caption: 'FIGURE 1 PRISMA flow diagram of study selection.',
      image: {bytes: pictureBytes, extension: 'png'},
      index: 1,
      page: 3,
    },
  ])
})

test('Docling figure captions fall back to child caption items when the picture has no caption refs', () => {
  const document = JSON.parse(documentText) as {pictures: Record<string, unknown>[]}
  const pictures = document.pictures.map((picture) => {
    return {...picture, captions: []}
  })
  const parsed = parseDoclingZipEntries({
    converterVersion: 'v',
    entries: {...getDoclingEntries(), 'paper.json': strToU8(JSON.stringify({...document, pictures}))},
  })

  expect(parsed.figures[0]?.caption).toBe('FIGURE 1 PRISMA flow diagram of study selection.')
  expect(parsed.layout[2]?.parts).toEqual([
    {text: 'FIGURE 1 PRISMA flow diagram of study selection.', type: 'image_caption'},
  ])
})

test('Docling zip parsing fails permanently when the markdown or JSON output is missing', () => {
  const {['paper.md']: _markdown, ...withoutMarkdown} = getDoclingEntries()
  const {['paper.json']: _json, ...withoutJson} = getDoclingEntries()

  expect(() => {
    return parseDoclingZipEntries({converterVersion: 'v', entries: withoutMarkdown})
  }).toThrow('Docling zip is missing the .md output')
  expect(() => {
    return parseDoclingZipEntries({converterVersion: 'v', entries: withoutJson})
  }).toThrow('Docling zip is missing the .json output')
})

test('Docling converter version lists every docling package from /version in name order', () => {
  expect(getDoclingConverterVersion(doclingVersion)).toBe('docling=2.140.0 docling-core=2.101.1 docling-serve=1.37.0')
  expect(() => {
    return getDoclingConverterVersion({docling: '2.140.0'})
  }).toThrow('Docling /version did not report a docling-serve version')
})

test('Docling converter sends the explicit options with a zip target and parses the archive', async () => {
  const bodies: Record<string, unknown>[] = []
  const baseURL = startDoclingServer(async (request) => {
    const path = new URL(request.url).pathname

    if (path === '/version') {
      return Response.json(doclingVersion)
    }

    bodies.push((await request.json()) as Record<string, unknown>)

    return new Response(zipSync(getDoclingEntries()).slice(), {headers: {'content-type': 'application/zip'}})
  })

  const parsed = await doclingConverter.convert({
    baseURL,
    fileName: 'paper.pdf',
    pdfBytes: new Uint8Array([37, 80, 68, 70]),
    timeoutMs: 60_000,
  })
  const [body] = bodies

  expect(body?.options).toEqual(doclingConvertOptions)
  expect(body?.target).toEqual({kind: 'zip'})
  expect(body?.sources).toEqual([{base64_string: 'JVBERg==', filename: 'paper.pdf', kind: 'file'}])
  expect(parsed.converterVersion).toBe('docling=2.140.0 docling-core=2.101.1 docling-serve=1.37.0')
  expect(parsed.figures).toHaveLength(1)
})

test('Docling converter fails transiently when /version is unavailable', async () => {
  const baseURL = startDoclingServer(() => {
    return new Response('not found', {status: 404})
  })

  const error = (await doclingConverter
    .convert({baseURL, fileName: 'paper.pdf', pdfBytes: new Uint8Array([1]), timeoutMs: 60_000})
    .catch((caught: unknown) => {
      return caught
    })) as ConversionError

  expect(error).toBeInstanceOf(ConversionError)
  expect(error.isPermanent).toBe(false)
  expect(error.message).toContain('Docling /version request failed: 404')
})
