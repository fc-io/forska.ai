import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {getProjectTransferCanonicalFullTextRebuildBlockers} from './projectTransferCanonicalFullTextRebuild.ts'
import type {ProjectTransferArticlePayloadRecord} from './projectTransferPayloadSchemas.ts'

const fixtureName = 'frontiers-fmed-2023-1283512.mineru'
const layoutPath = 'assets/full-text-assets/source-article/layout.json'

const readFixture = (fileName: string) => {
  return readFileSync(new URL(`../../fullText/fixtures/canonical/${fileName}`, import.meta.url), 'utf8')
}

const storedText = readFixture(`${fixtureName}.native_images.md`)
const storedHash = createHash('sha256').update(storedText, 'utf8').digest('hex')

const getArticle = (fields: Partial<ProjectTransferArticlePayloadRecord> = {}): ProjectTransferArticlePayloadRecord => {
  return {
    articleTitle: 'Source article',
    fullText: storedText,
    fullTextAssets: JSON.parse(readFixture(`${fixtureName}.assets.json`)) as unknown,
    fullTextCanonicalHash: storedHash,
    fullTextCanonicalVersion: 'canonical-v1',
    fullTextConversionMetadata: {
      converterKind: 'mineru',
      converterMarkdownPath: 'assets/full-text-assets/source-article/converter.md',
      layoutPath,
      layoutVersion: 'layout-v2',
    },
    fullTextFigureModeBuilt: 'markers',
    provenance: {sourceArticleId: 'source-article'},
    signature: {identifierKeys: [], title: 'Source article'},
    sourceArticleId: 'source-article',
    ...fields,
  }
}

const getBlockerCodes = async ({
  article,
  files = {[layoutPath]: readFixture(`${fixtureName}.layout.json`)},
}: {
  article: ProjectTransferArticlePayloadRecord
  files?: Record<string, string>
}) => {
  const blockers = await getProjectTransferCanonicalFullTextRebuildBlockers({
    articles: [article],
    readPackageFile: async (packagePath) => {
      const content = files[packagePath]

      return content ?? Promise.reject(new Error(`missing ${packagePath}`))
    },
  })

  return blockers.map((blocker) => {
    return `${blocker.code} ${blocker.scope}`
  })
}

test('project transfer analysis rebuilds a canonical article from its package layout and accepts the same hash', async () => {
  expect(await getBlockerCodes({article: getArticle()})).toEqual([])
})

test('project transfer analysis reports a canonical hash that the package layout does not rebuild', async () => {
  const otherLayout = readFixture('nejm-style.mineru.layout.json')

  expect(await getBlockerCodes({article: getArticle(), files: {[layoutPath]: otherLayout}})).toEqual([
    'article_full_text_canonical_rebuild_failed articles.source-article.fullTextCanonicalHash',
  ])
  expect(
    await getBlockerCodes({article: getArticle({fullTextAssets: []}), files: {[layoutPath]: otherLayout}}),
  ).toEqual(['article_full_text_canonical_rebuild_mismatch articles.source-article.fullTextCanonicalHash'])
})

test('project transfer analysis reports a missing, malformed or old package layout and an unknown converter', async () => {
  const oldLayout = JSON.stringify({blocks: [], version: 'layout-v1'})
  const failed = ['article_full_text_canonical_rebuild_failed articles.source-article.fullTextCanonicalHash']

  expect(await getBlockerCodes({article: getArticle(), files: {}})).toEqual(failed)
  expect(await getBlockerCodes({article: getArticle(), files: {[layoutPath]: '{not json'}})).toEqual(failed)
  expect(await getBlockerCodes({article: getArticle(), files: {[layoutPath]: oldLayout}})).toEqual(failed)
  expect(
    await getBlockerCodes({article: getArticle({fullTextConversionMetadata: {converterKind: 'pandoc', layoutPath}})}),
  ).toEqual(failed)
})

test('project transfer analysis rebuilds only articles stored in the marker form of this canonical text version', async () => {
  expect(
    await getBlockerCodes({
      article: getArticle({fullTextCanonicalHash: null, fullTextCanonicalVersion: null}),
      files: {},
    }),
  ).toEqual([])
  expect(await getBlockerCodes({article: getArticle({fullTextCanonicalVersion: 'canonical-v0'}), files: {}})).toEqual(
    [],
  )
  expect(await getBlockerCodes({article: getArticle({fullTextFigureModeBuilt: 'none'}), files: {}})).toEqual([])
  expect(await getBlockerCodes({article: getArticle({fullTextFigureModeBuilt: 'native_images'}), files: {}})).toEqual([
    'article_full_text_canonical_rebuild_failed articles.source-article.fullTextCanonicalHash',
  ])
})
