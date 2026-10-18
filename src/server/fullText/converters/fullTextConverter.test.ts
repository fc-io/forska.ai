import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, expect, test} from 'bun:test'
import {strToU8, zipSync} from 'fflate'

import {ConversionError} from './conversionError.ts'
import {
  convertArticlePdf,
  getFullTextConversionMetadata,
  getFullTextConverter,
  isPermanentConversionFailure,
} from './fullTextConverter.ts'

const middleJsonText = readFileSync(new URL('./fixtures/mineruMiddleJson.json', import.meta.url), 'utf8')
const imageBytes = new Uint8Array([255, 216, 255, 224, 7])
const cleanups: (() => void)[] = []

const getRuntimeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'forska-fulltext-converter-'))
  cleanups.push(() => {
    rmSync(root, {force: true, recursive: true})
  })

  return root
}

const startMineruServer = () => {
  const server = globalThis.Bun.serve({
    fetch: () => {
      return new Response(
        zipSync({
          'images/page_2_image_10.jpg': imageBytes,
          'markdown.md': strToU8('# Converted\n'),
          'middle_json.json': strToU8(middleJsonText),
        }).slice(),
        {headers: {'content-type': 'application/zip'}},
      )
    },
    port: 0,
  })
  cleanups.push(() => {
    void server.stop(true)
  })

  return server.url.toString().replace(/\/$/, '')
}

const runtimeConfig = (baseURL: string) => {
  return {
    baseURL,
    modelId: 'model-mineru',
    modelName: 'mineru-standard',
    providerConnectionId: 'connection-mineru',
    providerKind: 'mineru',
  }
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => {
    cleanup()
  })
})

test('PDF conversion picks the converter from the configured provider kind and refuses other kinds', () => {
  expect(getFullTextConverter('mineru').kind).toBe('mineru')
  expect(getFullTextConverter('docling').kind).toBe('docling')
  expect(() => {
    return getFullTextConverter('sglang')
  }).toThrow('Provider kind sglang is not a PDF conversion provider')
})

test('PDF conversion writes figure crops and layout under the runtime full-text assets dir', async () => {
  const root = getRuntimeRoot()
  const baseURL = startMineruServer()

  await mkdir(join(root, 'assets/article_pdfs'), {recursive: true})
  await writeFile(join(root, 'assets/article_pdfs/paper.pdf'), '%PDF-1.4')
  await mkdir(join(root, 'assets/full-text-assets/article-1'), {recursive: true})
  writeFileSync(join(root, 'assets/full-text-assets/article-1/fig-9.png'), 'stale')

  const result = await convertArticlePdf({
    articleId: 'article-1',
    cwd: root,
    pdfPath: 'assets/article_pdfs/paper.pdf',
    runtimeConfig: runtimeConfig(baseURL),
    timeoutMs: 60_000,
  })

  expect(result.converterKind).toBe('mineru')
  expect(result.converterVersion).toBe('4.0.12')
  expect(result.optionsHash).toBe('e9d85ef6fe205701cea9cf7f29abcc18f3ba884041b2f392facf5262be7ffb96')
  expect(result.markdown).toBe('# Converted\n')
  expect(result.layoutPath).toBe('assets/full-text-assets/article-1/layout.json')
  expect(result.figures).toEqual([
    {
      bbox: [0.082, 0.513, 0.488, 0.915],
      caption: 'FIGURE 1 PRISMA flow diagram of study selection.',
      imagePath: 'assets/full-text-assets/article-1/fig-1.jpg',
      index: 1,
      page: 3,
    },
  ])
  expect(result.converterMarkdownPath).toBe('assets/full-text-assets/article-1/converter.md')
  expect((await readdir(join(root, 'assets/full-text-assets/article-1'))).sort()).toEqual([
    'converter.md',
    'fig-1.jpg',
    'layout.json',
  ])
  expect(new Uint8Array(await readFile(join(root, 'assets/full-text-assets/article-1/fig-1.jpg')))).toEqual(imageBytes)
  expect(JSON.parse(await readFile(join(root, result.layoutPath), 'utf8'))).toEqual({
    blocks: result.layout,
    version: 'layout-v2',
  })
  expect(await readFile(join(root, result.converterMarkdownPath), 'utf8')).toBe('# Converted\n')
})

test('PDF conversion fails permanently when the PDF file is missing', async () => {
  const root = getRuntimeRoot()
  const error = await convertArticlePdf({
    articleId: 'article-2',
    cwd: root,
    pdfPath: 'assets/article_pdfs/missing.pdf',
    runtimeConfig: runtimeConfig('http://127.0.0.1:1'),
    timeoutMs: 60_000,
  }).catch((caught: unknown) => {
    return caught
  })

  expect(error).toBeInstanceOf(ConversionError)
  expect(isPermanentConversionFailure(error)).toBe(true)
})

test('conversion metadata records converter identity next to the configured model', () => {
  const metadata = getFullTextConversionMetadata({
    result: {
      converterKind: 'mineru',
      converterMarkdownPath: 'assets/full-text-assets/a/converter.md',
      converterVersion: '4.0.12',
      figures: [],
      html: null,
      layout: [],
      layoutPath: 'assets/full-text-assets/a/layout.json',
      markdown: '# x',
      optionsHash: 'hash-1',
    },
    runtimeConfig: runtimeConfig('http://127.0.0.1:8000'),
  })

  expect(metadata).toEqual({
    baseURL: 'http://127.0.0.1:8000',
    converterKind: 'mineru',
    converterMarkdownPath: 'assets/full-text-assets/a/converter.md',
    converterVersion: '4.0.12',
    layoutPath: 'assets/full-text-assets/a/layout.json',
    layoutVersion: 'layout-v2',
    modelId: 'model-mineru',
    modelName: 'mineru-standard',
    optionsHash: 'hash-1',
    providerKind: 'mineru',
  })
})
