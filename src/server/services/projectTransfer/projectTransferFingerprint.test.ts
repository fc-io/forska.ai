import {expect, test} from 'bun:test'

import {
  getProjectTransferCanonicalJson,
  getProjectTransferCanonicalNdjson,
  getProjectTransferLogicalPackageFingerprint,
  getProjectTransferSchemaVNextLogicalPackageFingerprintFromDigests,
  getProjectTransferSchemaVNextSingletonPayloadDigest,
  getProjectTransferSchemaVNextStagedRowDigest,
  getProjectTransferSha256Checksum,
} from './projectTransferFingerprint.ts'
import {buildProjectTransferManifest, getProjectTransferManifestPayloadEntry} from './projectTransferManifest.ts'
import {
  projectTransferPayloadFormatByKey,
  type ProjectTransferPayloadKey,
  projectTransferPayloadKeys,
  projectTransferPayloadPathByKey,
  projectTransferSchemaVNextManifestSchemaVersion,
  projectTransferSchemaVNextPayloadFormatByKey,
  type ProjectTransferSchemaVNextPayloadKey,
  projectTransferSchemaVNextPayloadKeys,
  projectTransferSchemaVNextPayloadPathByKey,
} from './projectTransferSchemas.ts'

const getPayloadManifestEntries = (entries: Partial<Record<ProjectTransferPayloadKey, string>>) => {
  return projectTransferPayloadKeys.reduce(
    (payloads, key) => {
      const bytes = entries[key] ?? ''

      return {
        ...payloads,
        [key]: getProjectTransferManifestPayloadEntry({
          bytes,
          format: projectTransferPayloadFormatByKey[key],
          path: projectTransferPayloadPathByKey[key],
          recordCount: bytes === '' ? 0 : 1,
        }),
      }
    },
    {} as ReturnType<typeof buildProjectTransferManifest>['payloads'],
  )
}

const getSchemaVNextPayloadManifestEntries = (
  entries: Partial<Record<ProjectTransferSchemaVNextPayloadKey, string>>,
) => {
  return projectTransferSchemaVNextPayloadKeys.reduce(
    (payloads, key) => {
      const bytes = entries[key] ?? ''

      return {
        ...payloads,
        [key]: getProjectTransferManifestPayloadEntry({
          bytes,
          format: projectTransferSchemaVNextPayloadFormatByKey[key],
          path: projectTransferSchemaVNextPayloadPathByKey[key],
          recordCount: bytes === '' ? 0 : 1,
        }),
      }
    },
    {} as ReturnType<typeof buildProjectTransferManifest>['payloads'],
  )
}

const getProjectSummary = (checksumSeed: string) => {
  return {
    counts: projectTransferPayloadKeys.reduce(
      (counts, key) => {
        return {...counts, [key]: 0}
      },
      {} as Record<ProjectTransferPayloadKey, number>,
    ),
    currentModel: {modelName: 'GPT 5.4', remoteModelId: 'gpt-5.4', sourceModelId: `model-${checksumSeed}`},
    humanJudgmentMode: 'prompt' as const,
    name: 'Source Project',
    sourceProjectId: `source-project-${checksumSeed}`,
  }
}

const getSchemaVNextProjectSummary = (checksumSeed: string) => {
  return {
    ...getProjectSummary(checksumSeed),
    counts: projectTransferSchemaVNextPayloadKeys.reduce(
      (counts, key) => {
        return {...counts, [key]: 0}
      },
      {} as Record<ProjectTransferSchemaVNextPayloadKey, number>,
    ),
  }
}

const getManifest = (checksumSeed: string) => {
  return buildProjectTransferManifest({
    exportedAt: `2026-05-21T07:00:0${checksumSeed}.000Z`,
    payloads: getPayloadManifestEntries({
      articles: `articles-${checksumSeed}`,
      project: `project-${checksumSeed}`,
      providerConnections: `provider-connections-${checksumSeed}`,
    }),
    project: getProjectSummary(checksumSeed),
    sourceAppVersion: '0.2.1',
  })
}

const getAssetManifest = (checksumSeed: string) => {
  return buildProjectTransferManifest({
    exportedAt: `2026-05-21T07:00:0${checksumSeed}.000Z`,
    payloads: getPayloadManifestEntries({assetManifest: `asset-manifest-${checksumSeed}`}),
    project: getProjectSummary(checksumSeed),
    sourceAppVersion: '0.2.1',
  })
}

const getProvenanceIdManifest = (checksumSeed: string) => {
  return buildProjectTransferManifest({
    exportedAt: `2026-05-21T07:00:0${checksumSeed}.000Z`,
    payloads: getPayloadManifestEntries({
      humanJudgments: `human-judgments-${checksumSeed}`,
      judgments: `judgments-${checksumSeed}`,
      projectPrompts: `project-prompts-${checksumSeed}`,
      reviews: `reviews-${checksumSeed}`,
    }),
    project: getProjectSummary(checksumSeed),
    sourceAppVersion: '0.2.1',
  })
}

const getSchemaVNextManifest = (checksumSeed: string) => {
  return buildProjectTransferManifest({
    exportedAt: `2026-05-21T07:00:0${checksumSeed}.000Z`,
    payloads: getSchemaVNextPayloadManifestEntries({
      articles: `articles-${checksumSeed}`,
      project: `project-${checksumSeed}`,
    }),
    project: getSchemaVNextProjectSummary(checksumSeed),
    schemaVersion: projectTransferSchemaVNextManifestSchemaVersion,
    sourceAppVersion: '0.2.1',
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

test('project-transfer duplicate fingerprints handle large logically equivalent payload strings', () => {
  const firstPayload = Array.from({length: 2000}, (_, index) => {
    return {
      articleTitle: `row-${index}-${'x'.repeat(1024)}`,
      createdAt: '2026-05-21T07:00:00.000Z',
      id: `article-a-${index}`,
    }
  })
  const secondPayload = Array.from({length: 2000}, (_, index) => {
    const reversedIndex = 1999 - index

    return {
      articleTitle: `row-${reversedIndex}-${'x'.repeat(1024)}`,
      createdAt: '2026-05-22T07:00:00.000Z',
      id: `article-b-${reversedIndex}`,
    }
  })
  const firstFingerprint = getProjectTransferLogicalPackageFingerprint({
    manifest: getManifest('9'),
    payloads: {articles: firstPayload},
  })
  const secondFingerprint = getProjectTransferLogicalPackageFingerprint({
    manifest: getManifest('10'),
    payloads: {articles: secondPayload},
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

test('schema-vNext staged row digests exclude ids and timestamps from sort keys', () => {
  const firstDigest = getProjectTransferSchemaVNextStagedRowDigest({
    payloadKey: 'articles',
    row: {
      articleTitle: 'Stable Article',
      createdAt: '2026-05-21T07:00:00.000Z',
      id: 'db-row-1',
      sourceArticleId: 'source-article-1',
      targetArticleId: 'target-article-1',
      updatedAt: '2026-05-21T07:00:00.000Z',
    },
  })
  const secondDigest = getProjectTransferSchemaVNextStagedRowDigest({
    payloadKey: 'articles',
    row: {
      articleTitle: 'Stable Article',
      createdAt: '2026-05-22T07:00:00.000Z',
      id: 'db-row-2',
      sourceArticleId: 'source-article-2',
      targetArticleId: 'target-article-2',
      updatedAt: '2026-05-22T07:00:00.000Z',
    },
  })
  const changedDigest = getProjectTransferSchemaVNextStagedRowDigest({
    payloadKey: 'articles',
    row: {articleTitle: 'Changed Article', sourceArticleId: 'source-article-2', targetArticleId: 'target-article-2'},
  })

  expect(firstDigest.sortKey).toBe(firstDigest.digestSha256)
  expect(secondDigest.sortKey).toBe(firstDigest.sortKey)
  expect(changedDigest.sortKey).not.toBe(firstDigest.sortKey)
})

test('schema-vNext package fingerprints use staged row digests and singleton payload digests', () => {
  const firstProjectPayload = {
    createdAt: '2026-05-21T07:00:00.000Z',
    name: 'Shared Review',
    sourceProjectId: 'source-project-a',
  }
  const secondProjectPayload = {
    createdAt: '2026-05-22T07:00:00.000Z',
    name: 'Shared Review',
    sourceProjectId: 'source-project-b',
  }
  const firstRows = [
    {articleTitle: 'Beta', sourceArticleId: 'source-beta', targetArticleId: 'target-beta'},
    {articleTitle: 'Alpha', sourceArticleId: 'source-alpha', targetArticleId: 'target-alpha'},
  ]
  const secondRows = [
    {articleTitle: 'Alpha', sourceArticleId: 'source-alpha-reimport', targetArticleId: 'target-alpha-reimport'},
    {articleTitle: 'Beta', sourceArticleId: 'source-beta-reimport', targetArticleId: 'target-beta-reimport'},
  ]
  const firstFingerprint = getProjectTransferLogicalPackageFingerprint({
    manifest: getSchemaVNextManifest('1'),
    payloads: {articles: firstRows, project: firstProjectPayload},
  })
  const secondFingerprint = getProjectTransferLogicalPackageFingerprint({
    manifest: getSchemaVNextManifest('2'),
    payloads: {articles: secondRows, project: secondProjectPayload},
  })
  const digestFingerprint = getProjectTransferSchemaVNextLogicalPackageFingerprintFromDigests({
    manifest: getSchemaVNextManifest('3'),
    rowDigests: firstRows.map((row) => {
      return getProjectTransferSchemaVNextStagedRowDigest({payloadKey: 'articles', row})
    }),
    singletonPayloadDigests: [
      getProjectTransferSchemaVNextSingletonPayloadDigest({payloadKey: 'project', value: firstProjectPayload}),
    ],
  })

  expect(firstFingerprint).toBe(secondFingerprint)
  expect(digestFingerprint).toBe(firstFingerprint)
})
