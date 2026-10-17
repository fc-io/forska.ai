import {readFileSync} from 'node:fs'

import {afterEach, expect, test} from 'bun:test'
import {strToU8, zipSync} from 'fflate'

import {ConversionError} from './conversionError.ts'
import {getMineruFileParseUrl, mineruConverter, parseMineruZipEntries} from './mineruConverter.ts'

const middleJsonText = readFileSync(new URL('./fixtures/mineruMiddleJson.json', import.meta.url), 'utf8')
const imageBytes = new Uint8Array([255, 216, 255, 224, 1, 2, 3])
const servers: {stop: (force?: boolean) => void}[] = []

const getMineruZip = (overrides: Record<string, Uint8Array | null> = {}): Uint8Array => {
  const entries: Record<string, Uint8Array | null> = {
    'images/page_2_image_10.jpg': imageBytes,
    'images/page_2_table_12.jpg': new Uint8Array([9]),
    'markdown.md': strToU8('# Title\n\n![](images/page_2_image_10.jpg)\n'),
    'middle_json.json': strToU8(middleJsonText),
    ...overrides,
  }

  return zipSync(
    Object.fromEntries(
      Object.entries(entries).filter((entry): entry is [string, Uint8Array] => {
        return entry[1] !== null
      }),
    ),
  )
}

const startMineruServer = (handler: (request: Request) => Response | Promise<Response>) => {
  const server = globalThis.Bun.serve({fetch: handler, port: 0})
  servers.push(server)

  return server.url.toString().replace(/\/$/, '')
}

const getPdfRequest = (baseURL: string) => {
  return {baseURL, fileName: 'paper.pdf', pdfBytes: new Uint8Array([37, 80, 68, 70]), timeoutMs: 60_000}
}

afterEach(() => {
  servers.splice(0).forEach((server) => {
    server.stop(true)
  })
})

test('MinerU zip parsing returns markdown, layout in page order and figures with captions', () => {
  const parsed = parseMineruZipEntries({
    'images/page_2_image_10.jpg': imageBytes,
    'markdown.md': strToU8('# Title'),
    'middle_json.json': strToU8(middleJsonText),
  })

  expect(parsed.converterVersion).toBe('4.0.12')
  expect(parsed.markdown).toBe('# Title')
  expect(parsed.html).toBeNull()
  expect(
    parsed.layout.map((block) => {
      return [block.page, block.type]
    }),
  ).toEqual([
    [1, 'header'],
    [1, 'header'],
    [3, 'text'],
    [3, 'image'],
    [3, 'table'],
  ])
  expect(parsed.layout[1]?.text).toContain('TYPE Systematic Review')
  expect(parsed.layout[2]?.bbox).toEqual([0.077, 0.152, 0.492, 0.295])
  expect(parsed.layout[4]?.text).toContain('<table><tr><td>Study</td>')
  expect(parsed.layout[3]).toMatchObject({
    figureIndex: 1,
    parts: [
      {text: '', type: 'image_body'},
      {text: 'FIGURE 1 PRISMA flow diagram of study selection.', type: 'image_caption'},
    ],
  })
  expect(parsed.layout[4]?.parts).toEqual([
    {text: 'TABLE1Characteristicsoftheincludedtrials.', type: 'table_caption'},
    {
      text: '<table><tr><td>Study</td><td>Country</td></tr><tr><td>Xia 2023</td><td>China</td></tr></table>',
      type: 'table_body',
    },
  ])
  expect(parsed.layout[4]?.figureIndex).toBeUndefined()
  expect(parsed.figures).toEqual([
    {
      bbox: [0.082, 0.513, 0.488, 0.915],
      caption: 'FIGURE 1 PRISMA flow diagram of study selection.',
      image: {bytes: imageBytes, extension: 'jpg'},
      index: 1,
      page: 3,
    },
  ])
})

test('MinerU zip parsing skips figure blocks whose crop is missing from the zip', () => {
  const parsed = parseMineruZipEntries({'markdown.md': strToU8('# Title'), 'middle_json.json': strToU8(middleJsonText)})

  expect(parsed.figures).toEqual([])
  expect(parsed.layout[3]?.figureIndex).toBeUndefined()
})

test('MinerU layout keeps heading levels, continuation flags, list items and inline equation delimiters', () => {
  const middleJson = {
    metadata: {producer: {name: 'mineru', version: '4.0.12'}},
    pages: [
      {
        blocks: [
          {
            bbox: [0.1, 0.1, 0.9, 0.12],
            content: [{content: '2.1 Participants', type: 'text'}],
            level: 3,
            type: 'paragraph_title',
          },
          {
            bbox: [0.1, 0.2, 0.9, 0.3],
            content: [
              {content: 'Each grid has an ', type: 'text'},
              {content: 'S \\times S', type: 'equation_inline'},
              {content: ' layout.', type: 'text'},
            ],
            continues_prev: true,
            type: 'text',
          },
          {
            bbox: [0.1, 0.4, 0.9, 0.5],
            content: [
              {content: [{content: 'First item', type: 'text'}], type: 'text'},
              {content: [{content: [{content: 'Nested item', type: 'text'}], type: 'text'}], type: 'list'},
              {content: [{content: 'Smith J. A reference.', type: 'text'}], type: 'ref_text'},
            ],
            type: 'list',
          },
        ],
        page_idx: 0,
      },
    ],
  }
  const parsed = parseMineruZipEntries({
    'markdown.md': strToU8('# Title'),
    'middle_json.json': strToU8(JSON.stringify(middleJson)),
  })

  expect(parsed.layout[0]).toMatchObject({level: 3, text: '2.1 Participants', type: 'paragraph_title'})
  expect(parsed.layout[1]).toMatchObject({continuesPrevious: true, text: 'Each grid has an $S \\times S$ layout.'})
  expect(parsed.layout[2]?.parts).toEqual([
    {text: 'First item', type: 'text'},
    {depth: 1, text: 'Nested item', type: 'text'},
    {text: 'Smith J. A reference.', type: 'ref_text'},
  ])
})

test('MinerU zip parsing fails permanently without markdown or producer version', () => {
  const missingMarkdown = () => {
    return parseMineruZipEntries({'middle_json.json': strToU8(middleJsonText)})
  }
  const missingVersion = () => {
    return parseMineruZipEntries({'markdown.md': strToU8('# Title'), 'middle_json.json': strToU8('{"pages":[]}')})
  }

  expect(missingMarkdown).toThrow('MinerU zip is missing markdown.md')
  expect(missingVersion).toThrow('MinerU middle_json.json is missing metadata.producer.version')
})

test('MinerU file_parse URL carries every explicit option plus the zip response and wait timeout', () => {
  const url = new URL(getMineruFileParseUrl({baseURL: 'http://127.0.0.1:8000/', timeoutMs: 600_000}))

  expect(url.pathname).toBe('/v1/file_parse')
  expect(url.searchParams.get('tier')).toBe('standard')
  expect(url.searchParams.get('ocr_mode')).toBe('auto')
  expect(url.searchParams.get('page_range')).toBe('')
  expect(url.searchParams.getAll('output_formats')).toEqual(['markdown', 'middle_json', 'zip'])
  expect(url.searchParams.get('response_format')).toBe('zip')
  expect(url.searchParams.get('wait_timeout')).toBe('585')
})

test('MinerU converter uploads the PDF as multipart files and parses the zip response', async () => {
  const requests: {fileName: string | null; method: string; search: string}[] = []
  const baseURL = startMineruServer(async (request) => {
    const form = await request.formData()
    const file = form.get('files')

    requests.push({
      fileName: file instanceof File ? file.name : null,
      method: request.method,
      search: new URL(request.url).search,
    })

    return new Response(getMineruZip().slice(), {headers: {'content-type': 'application/zip'}})
  })

  const parsed = await mineruConverter.convert(getPdfRequest(baseURL))

  expect(requests).toHaveLength(1)
  expect(requests[0]?.method).toBe('POST')
  expect(requests[0]?.fileName).toBe('paper.pdf')
  expect(requests[0]?.search).toContain('tier=standard')
  expect(parsed.converterVersion).toBe('4.0.12')
  expect(parsed.figures).toHaveLength(1)
})

test('MinerU converter cancels the task and fails transiently when the server answers 202', async () => {
  const deletes: string[] = []
  const baseURL = startMineruServer((request) => {
    if (request.method === 'DELETE') {
      deletes.push(new URL(request.url).pathname)
    }

    return request.method === 'DELETE'
      ? Response.json({status: 'canceled'})
      : Response.json({status: 'processing', task_id: 'task-1'}, {status: 202})
  })

  const error = await mineruConverter.convert(getPdfRequest(baseURL)).catch((caught: unknown) => {
    return caught
  })

  expect(error).toBeInstanceOf(ConversionError)
  expect((error as ConversionError).isPermanent).toBe(false)
  expect((error as ConversionError).message).toContain('task task-1 canceled')
  expect(deletes).toEqual(['/v1/tasks/task-1'])
})

test('MinerU converter keeps server errors transient unless the status is a client error', async () => {
  const serverErrorURL = startMineruServer(() => {
    return new Response('boom', {status: 500, statusText: 'Internal Server Error'})
  })
  const clientErrorURL = startMineruServer(() => {
    return new Response('bad pdf', {status: 422, statusText: 'Unprocessable Entity'})
  })

  const serverError = (await mineruConverter.convert(getPdfRequest(serverErrorURL)).catch((caught: unknown) => {
    return caught
  })) as ConversionError
  const clientError = (await mineruConverter.convert(getPdfRequest(clientErrorURL)).catch((caught: unknown) => {
    return caught
  })) as ConversionError

  expect(serverError.status).toBe(500)
  expect(serverError.isPermanent).toBe(false)
  expect(clientError.status).toBe(422)
  expect(clientError.isPermanent).toBe(true)
})

test('MinerU converter treats an unreachable server as a transient failure', async () => {
  const server = globalThis.Bun.serve({
    fetch: () => {
      return new Response('unused')
    },
    port: 0,
  })
  const baseURL = server.url.toString().replace(/\/$/, '')
  await server.stop(true)

  const error = (await mineruConverter.convert(getPdfRequest(baseURL)).catch((caught: unknown) => {
    return caught
  })) as ConversionError

  expect(error).toBeInstanceOf(ConversionError)
  expect(error.isPermanent).toBe(false)
})
