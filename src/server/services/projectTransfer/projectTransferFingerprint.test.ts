import {expect, test} from 'bun:test'

import {
  getProjectTransferCanonicalJson,
  getProjectTransferCanonicalNdjson,
  getProjectTransferLogicalPackageFingerprint,
  getProjectTransferSha256Checksum,
} from './projectTransferFingerprint.ts'
import {buildProjectTransferManifest, getProjectTransferManifestPayloadEntry} from './projectTransferManifest.ts'

const getManifest = (checksumSeed: string) => {
  return buildProjectTransferManifest({
    generatedAt: `2026-05-21T07:00:0${checksumSeed}.000Z`,
    payloads: {
      articles: getProjectTransferManifestPayloadEntry({
        bytes: `articles-${checksumSeed}`,
        format: 'ndjson',
        path: 'articles.ndjson',
        recordCount: 2,
      }),
      project: getProjectTransferManifestPayloadEntry({
        bytes: `project-${checksumSeed}`,
        format: 'json',
        path: 'project.json',
        recordCount: 1,
      }),
    },
    source: {projectId: `source-project-${checksumSeed}`, projectName: 'Source Project'},
  })
}

const projectPayload = {
  createdAt: '2026-05-21T07:00:00.000Z',
  id: 'source-project-a',
  name: 'Shared Review',
  settings: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
  sourceProjectId: 'source-project-a',
  updatedAt: '2026-05-21T07:00:00.000Z',
}

const logicallyEquivalentProjectPayload = {
  createdAt: '2026-05-22T07:00:00.000Z',
  id: 'source-project-b',
  name: 'Shared Review',
  settings: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
  sourceProjectId: 'source-project-b',
  updatedAt: '2026-05-22T07:00:00.000Z',
}

const articlesPayload = [
  {
    articleTitle: 'Beta',
    createdAt: '2026-05-21T07:00:00.000Z',
    id: 'article-source-b',
    sourceRecordKey: 'source-record-b',
  },
  {
    articleTitle: 'Alpha',
    createdAt: '2026-05-21T07:00:00.000Z',
    id: 'article-source-a',
    sourceRecordKey: 'source-record-a',
  },
]

const logicallyEquivalentArticlesPayload = [
  {
    articleTitle: 'Alpha',
    createdAt: '2026-05-22T07:00:00.000Z',
    id: 'article-source-a-reimport',
    sourceRecordKey: 'source-record-a-reimport',
  },
  {
    articleTitle: 'Beta',
    createdAt: '2026-05-22T07:00:00.000Z',
    id: 'article-source-b-reimport',
    sourceRecordKey: 'source-record-b-reimport',
  },
]

test('canonical JSON and NDJSON helpers produce deterministic checksum input', () => {
  expect(getProjectTransferCanonicalJson({b: 1, a: {d: 4, c: 3}})).toBe('{"a":{"c":3,"d":4},"b":1}')
  expect(getProjectTransferCanonicalNdjson([{b: 2}, {a: 1}])).toBe('{"a":1}\n{"b":2}\n')
  expect(getProjectTransferSha256Checksum('project-transfer')).toMatch(/^[a-f0-9]{64}$/)
})

test('project-transfer duplicate fingerprints are stable across ordering and provenance changes', () => {
  const firstFingerprint = getProjectTransferLogicalPackageFingerprint({
    manifest: getManifest('1'),
    payloads: {articles: articlesPayload, project: projectPayload},
  })
  const secondFingerprint = getProjectTransferLogicalPackageFingerprint({
    manifest: getManifest('2'),
    payloads: {articles: logicallyEquivalentArticlesPayload, project: logicallyEquivalentProjectPayload},
  })

  expect(firstFingerprint).toBe(secondFingerprint)
})

test('project-transfer duplicate fingerprints change when logical package content changes', () => {
  const baseFingerprint = getProjectTransferLogicalPackageFingerprint({
    manifest: getManifest('1'),
    payloads: {articles: articlesPayload, project: projectPayload},
  })
  const changedFingerprint = getProjectTransferLogicalPackageFingerprint({
    manifest: getManifest('1'),
    payloads: {
      articles: articlesPayload.map((article) => {
        return article.articleTitle === 'Alpha' ? {...article, articleTitle: 'Gamma'} : article
      }),
      project: projectPayload,
    },
  })

  expect(changedFingerprint).not.toBe(baseFingerprint)
})
