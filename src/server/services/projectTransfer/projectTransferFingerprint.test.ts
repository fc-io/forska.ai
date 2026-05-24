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
      providerConnections: getProjectTransferManifestPayloadEntry({
        bytes: `provider-connections-${checksumSeed}`,
        format: 'json',
        path: 'providerConnections.json',
        recordCount: 2,
      }),
    },
    source: {projectId: `source-project-${checksumSeed}`, projectName: 'Source Project'},
  })
}

const getAssetManifest = (checksumSeed: string) => {
  return buildProjectTransferManifest({
    generatedAt: `2026-05-21T07:00:0${checksumSeed}.000Z`,
    payloads: {
      assetManifest: getProjectTransferManifestPayloadEntry({
        bytes: `asset-manifest-${checksumSeed}`,
        format: 'json',
        path: 'assetManifest.json',
        recordCount: 1,
      }),
    },
    source: {projectId: `source-project-${checksumSeed}`, projectName: 'Source Project'},
  })
}

const getProvenanceIdManifest = (checksumSeed: string) => {
  return buildProjectTransferManifest({
    generatedAt: `2026-05-21T07:00:0${checksumSeed}.000Z`,
    payloads: {
      humanJudgments: getProjectTransferManifestPayloadEntry({
        bytes: `human-judgments-${checksumSeed}`,
        format: 'ndjson',
        path: 'humanJudgments.ndjson',
        recordCount: 1,
      }),
      judgments: getProjectTransferManifestPayloadEntry({
        bytes: `judgments-${checksumSeed}`,
        format: 'ndjson',
        path: 'judgments.ndjson',
        recordCount: 1,
      }),
      projectPrompts: getProjectTransferManifestPayloadEntry({
        bytes: `project-prompts-${checksumSeed}`,
        format: 'json',
        path: 'projectPrompts.json',
        recordCount: 1,
      }),
      reviews: getProjectTransferManifestPayloadEntry({
        bytes: `reviews-${checksumSeed}`,
        format: 'ndjson',
        path: 'reviews.ndjson',
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

const providerConnectionsPayload = {
  records: [
    {
      createdAt: '2026-05-21T07:00:00.000Z',
      id: 'provider-connection-b',
      provider: 'provider-b',
      settings: {baseUrl: 'https://provider-b.example.test'},
    },
    {
      createdAt: '2026-05-21T07:00:00.000Z',
      id: 'provider-connection-a',
      provider: 'provider-a',
      settings: {baseUrl: 'https://provider-a.example.test'},
    },
  ],
}

const logicallyEquivalentProviderConnectionsPayload = {
  records: [
    {
      createdAt: '2026-05-22T07:00:00.000Z',
      id: 'provider-connection-a-reimport',
      provider: 'provider-a',
      settings: {baseUrl: 'https://provider-a.example.test'},
    },
    {
      createdAt: '2026-05-22T07:00:00.000Z',
      id: 'provider-connection-b-reimport',
      provider: 'provider-b',
      settings: {baseUrl: 'https://provider-b.example.test'},
    },
  ],
}

const getProvenanceIdPayloads = (idSeed: string) => {
  return {
    humanJudgments: [
      {
        answer: 'yes',
        isAnswered: true,
        sourceArticleId: `source-article-${idSeed}`,
        sourceHumanJudgmentId: `source-human-judgment-${idSeed}`,
        sourceProjectId: `source-project-${idSeed}`,
        sourcePromptId: `source-prompt-${idSeed}`,
      },
    ],
    judgments: [
      {
        answer: 'yes',
        confidenceOriginal: 90,
        contentSettings: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
        isAnswered: true,
        quotes: ['same quote'],
        sourceArticleId: `source-article-${idSeed}`,
        sourceJudgmentId: `source-judgment-${idSeed}`,
        sourceModelId: `source-model-${idSeed}`,
        sourcePromptId: `source-prompt-${idSeed}`,
      },
    ],
    projectPrompts: {
      records: [
        {
          enabled: true,
          order: 1,
          promptLabel: 'Eligibility',
          sourceProjectId: `source-project-${idSeed}`,
          sourceProjectPromptId: `source-project-prompt-${idSeed}`,
          sourcePromptId: `source-prompt-${idSeed}`,
          targetProjectId: `target-project-${idSeed}`,
        },
      ],
    },
    reviews: [
      {
        opened: true,
        sections: {decision: 'include'},
        sourceArticleId: `source-article-${idSeed}`,
        sourceProjectId: `source-project-${idSeed}`,
        sourceReviewId: `source-review-${idSeed}`,
        targetId: `target-review-${idSeed}`,
      },
    ],
  }
}

const getAssetManifestPayload = (checksumSha256: string, byteLength = 11) => {
  return {
    entries: [
      {
        byteLength,
        checksumSha256,
        contentType: 'application/pdf',
        packagePath: 'assets/article-pdfs/article-1.pdf',
        references: [
          {
            fieldPath: 'articles[0].fullTextPdf',
            jsonPointer: '/0/fullTextPdf',
            kind: 'fullTextPdf',
            payloadFile: 'articles.ndjson',
            sourceArticleId: 'article-1',
            sourceRef: 'article:article-1',
          },
        ],
      },
    ],
  }
}

test('canonical JSON and NDJSON helpers produce deterministic checksum input', () => {
  expect(getProjectTransferCanonicalJson({b: 1, a: {d: 4, c: 3}})).toBe('{"a":{"c":3,"d":4},"b":1}')
  expect(getProjectTransferCanonicalNdjson([{b: 2}, {a: 1}])).toBe('{"a":1}\n{"b":2}\n')
  expect(getProjectTransferSha256Checksum('project-transfer')).toMatch(/^[a-f0-9]{64}$/)
})

test('project-transfer duplicate fingerprints are stable across ordering and provenance changes', () => {
  const firstFingerprint = getProjectTransferLogicalPackageFingerprint({
    manifest: getManifest('1'),
    payloads: {articles: articlesPayload, project: projectPayload, providerConnections: providerConnectionsPayload},
  })
  const secondFingerprint = getProjectTransferLogicalPackageFingerprint({
    manifest: getManifest('2'),
    payloads: {
      articles: logicallyEquivalentArticlesPayload,
      project: logicallyEquivalentProjectPayload,
      providerConnections: logicallyEquivalentProviderConnectionsPayload,
    },
  })

  expect(firstFingerprint).toBe(secondFingerprint)
})

test('project-transfer duplicate fingerprints ignore source and target id fields across payloads', () => {
  const firstFingerprint = getProjectTransferLogicalPackageFingerprint({
    manifest: getProvenanceIdManifest('1'),
    payloads: getProvenanceIdPayloads('a'),
  })
  const secondFingerprint = getProjectTransferLogicalPackageFingerprint({
    manifest: getProvenanceIdManifest('2'),
    payloads: getProvenanceIdPayloads('b'),
  })

  expect(firstFingerprint).toBe(secondFingerprint)
})

test('project-transfer duplicate fingerprints keep asset content checksums', () => {
  const firstFingerprint = getProjectTransferLogicalPackageFingerprint({
    manifest: getAssetManifest('1'),
    payloads: {assetManifest: getAssetManifestPayload('a'.repeat(64))},
  })
  const secondFingerprint = getProjectTransferLogicalPackageFingerprint({
    manifest: getAssetManifest('2'),
    payloads: {assetManifest: getAssetManifestPayload('a'.repeat(64), 12)},
  })
  const changedFingerprint = getProjectTransferLogicalPackageFingerprint({
    manifest: getAssetManifest('2'),
    payloads: {assetManifest: getAssetManifestPayload('b'.repeat(64))},
  })

  expect(firstFingerprint).toBe(secondFingerprint)
  expect(changedFingerprint).not.toBe(firstFingerprint)
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
