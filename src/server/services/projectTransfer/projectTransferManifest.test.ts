import {expect, test} from 'bun:test'

import {
  assertProjectTransferManifest,
  buildProjectTransferManifest,
  getProjectTransferManifestPayloadEntry,
  parseProjectTransferManifestJson,
  validateProjectTransferManifest,
} from './projectTransferManifest.ts'
import {
  projectTransferCurrentManifestSchemaVersion,
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

const validProjectBytes = '{"name":"Project transfer source"}'
const validArticlesBytes = '{"articleTitle":"Alpha"}\n'

const getPayloadBytes = (key: ProjectTransferPayloadKey) => {
  return key === 'project' ? validProjectBytes : key === 'articles' ? validArticlesBytes : ''
}

const getPayloads = () => {
  return projectTransferPayloadKeys.reduce(
    (payloads, key) => {
      return {
        ...payloads,
        [key]: getProjectTransferManifestPayloadEntry({
          bytes: getPayloadBytes(key),
          format: projectTransferPayloadFormatByKey[key],
          path: projectTransferPayloadPathByKey[key],
          recordCount: key === 'project' || key === 'articles' ? 1 : 0,
        }),
      }
    },
    {} as ReturnType<typeof buildProjectTransferManifest>['payloads'],
  )
}

const getSchemaVNextPayloadBytes = (key: ProjectTransferSchemaVNextPayloadKey) => {
  return key === 'project'
    ? validProjectBytes
    : key === 'articles'
      ? validArticlesBytes
      : key === 'assetEntries'
        ? '{"packagePath":"assets/project-transfer/session-1/article.pdf"}\n'
        : key === 'assetReferences'
          ? '{"assetPackagePath":"assets/project-transfer/session-1/article.pdf"}\n'
          : ''
}

const getSchemaVNextPayloads = () => {
  return projectTransferSchemaVNextPayloadKeys.reduce(
    (payloads, key) => {
      const bytes = getSchemaVNextPayloadBytes(key)

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

const getProjectSummary = () => {
  return {
    counts: projectTransferPayloadKeys.reduce(
      (counts, key) => {
        return {...counts, [key]: key === 'project' || key === 'articles' ? 1 : 0}
      },
      {} as Record<ProjectTransferPayloadKey, number>,
    ),
    currentModel: {modelName: 'GPT 5.4', remoteModelId: 'gpt-5.4', sourceModelId: 'model-1'},
    humanJudgmentMode: 'prompt' as const,
    name: 'Project transfer source',
    sourceProjectId: 'source-project-id',
  }
}

const getSchemaVNextProjectSummary = () => {
  return {
    ...getProjectSummary(),
    counts: projectTransferSchemaVNextPayloadKeys.reduce(
      (counts, key) => {
        return {...counts, [key]: key === 'project' || key === 'articles' ? 1 : 0}
      },
      {} as Record<ProjectTransferSchemaVNextPayloadKey, number>,
    ),
  }
}

const getValidManifest = () => {
  return buildProjectTransferManifest({
    assetSummary: {byteLength: 0, entryCount: 0},
    exportedAt: '2026-05-21T07:00:00.000Z',
    payloads: getPayloads(),
    project: getProjectSummary(),
    schemaVersion: projectTransferCurrentManifestSchemaVersion,
    sourceAppVersion: '0.2.1',
    warnings: [
      {
        action: 'redacted',
        code: 'redacted_secret',
        jsonPointer: '/records/0/secretRef',
        message: 'Provider connection secret was omitted',
        scope: 'providerConnections',
        severity: 'warning',
      },
    ],
  })
}

const getValidSchemaVNextManifest = () => {
  return buildProjectTransferManifest({
    assetSummary: {byteLength: 11, entryCount: 1},
    exportedAt: '2026-05-21T07:00:00.000Z',
    payloads: getSchemaVNextPayloads(),
    project: getSchemaVNextProjectSummary(),
    schemaVersion: projectTransferSchemaVNextManifestSchemaVersion,
    sourceAppVersion: '0.2.1',
  })
}

test('validates project-transfer manifest payload contracts with camelCase package keys', () => {
  const manifest = parseProjectTransferManifestJson(JSON.stringify(getValidManifest()))

  expect(manifest.schemaVersion).toBe(projectTransferCurrentManifestSchemaVersion)
  expect(manifest.exportedAt).toBe('2026-05-21T07:00:00.000Z')
  expect(manifest.sourceAppVersion).toBe('0.2.1')
  expect(manifest.project.sourceProjectId).toBe('source-project-id')
  expect(manifest.payloads.project?.path).toBe('project.json')
  expect(manifest.payloads.articles?.path).toBe('articles.ndjson')
  expect(manifest.payloads.project?.checksumSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(manifest.warnings?.[0]).toMatchObject({code: 'redacted_secret', scope: 'providerConnections'})
})

test('rejects unsupported project-transfer manifest schema versions', () => {
  const manifest = getValidManifest()
  const validation = validateProjectTransferManifest({
    ...manifest,
    schemaVersion: projectTransferSchemaVNextManifestSchemaVersion + 1,
  })

  expect(validation.ok).toBe(false)
  expect(() => {
    return assertProjectTransferManifest({
      ...manifest,
      schemaVersion: projectTransferSchemaVNextManifestSchemaVersion + 1,
    })
  }).toThrow('Unsupported project transfer manifest schema version: 3')
})

test('rejects non-camelCase or mismatched manifest payload references', () => {
  const manifest = getValidManifest()
  const providerConnectionEntry = getProjectTransferManifestPayloadEntry({
    bytes: '[]',
    format: 'json',
    path: 'providerConnections.json',
    recordCount: 0,
  })

  expect(() => {
    return assertProjectTransferManifest({
      ...manifest,
      payloads: {...manifest.payloads, provider_connections: providerConnectionEntry},
    })
  }).toThrow('Unknown payload key for schema 1: provider_connections')

  expect(() => {
    return assertProjectTransferManifest({
      ...manifest,
      payloads: {...manifest.payloads, project: {...manifest.payloads.project, path: 'projects.json'}},
    })
  }).toThrow('Payload project must reference project.json')
})

test('validates schema-vNext manifest payload paths and explicit asset payload entries', () => {
  const manifest = parseProjectTransferManifestJson(JSON.stringify(getValidSchemaVNextManifest()))
  const assetEntries = manifest.payloads.assetEntries
  const assetReferences = manifest.payloads.assetReferences

  expect(manifest.schemaVersion).toBe(projectTransferSchemaVNextManifestSchemaVersion)
  expect(manifest.payloads.assetManifest).toBeUndefined()
  expect(assetEntries?.path).toBe('payloads/assetEntries.ndjson')
  expect(assetEntries?.format).toBe('ndjson')
  expect(assetEntries?.recordCount).toBe(1)
  expect(assetEntries?.byteLength).toBeGreaterThan(0)
  expect(assetEntries?.checksumSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(assetReferences?.path).toBe('payloads/assetReferences.ndjson')
  expect(assetReferences?.recordCount).toBe(1)
})

test('rejects current-schema assetManifest and root payload paths in schema-vNext manifests', () => {
  const manifest = getValidSchemaVNextManifest()

  expect(() => {
    return assertProjectTransferManifest({
      ...manifest,
      payloads: {
        ...manifest.payloads,
        assetManifest: getProjectTransferManifestPayloadEntry({
          bytes: '{"entries":[]}',
          format: 'json',
          path: 'assetManifest.json',
          recordCount: 0,
        }),
      },
    })
  }).toThrow('Unknown payload key for schema 2: assetManifest')

  expect(() => {
    return assertProjectTransferManifest({
      ...manifest,
      payloads: {...manifest.payloads, articles: {...manifest.payloads.articles, path: 'articles.ndjson'}},
    })
  }).toThrow('Payload articles must reference payloads/articles.ndjson')
})
