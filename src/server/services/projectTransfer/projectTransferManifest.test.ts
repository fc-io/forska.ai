import {expect, test} from 'bun:test'

import {
  assertProjectTransferManifest,
  buildProjectTransferManifest,
  getProjectTransferManifestPayloadEntry,
  parseProjectTransferManifestJson,
  validateProjectTransferManifest,
} from './projectTransferManifest.ts'
import {projectTransferManifestSchemaVersion} from './projectTransferSchemas.ts'

const validProjectBytes = '{"name":"Project transfer source"}'
const validArticlesBytes = '{"articleTitle":"Alpha"}\n'

const getValidManifest = () => {
  return buildProjectTransferManifest({
    generatedAt: '2026-05-21T07:00:00.000Z',
    payloads: {
      articles: getProjectTransferManifestPayloadEntry({
        bytes: validArticlesBytes,
        format: 'ndjson',
        path: 'articles.ndjson',
        recordCount: 1,
      }),
      project: getProjectTransferManifestPayloadEntry({
        bytes: validProjectBytes,
        format: 'json',
        path: 'project.json',
        recordCount: 1,
      }),
    },
    source: {appVersion: '0.2.1', projectId: 'source-project-id', projectName: 'Project transfer source'},
    warnings: [
      {
        code: 'redacted_secret',
        message: 'Provider connection secret was omitted',
        payloadKey: 'providerConnections',
        severity: 'warning',
      },
    ],
  })
}

test('validates project-transfer manifest payload contracts with camelCase package keys', () => {
  const manifest = parseProjectTransferManifestJson(JSON.stringify(getValidManifest()))

  expect(manifest.schemaVersion).toBe(projectTransferManifestSchemaVersion)
  expect(manifest.payloads.project?.path).toBe('project.json')
  expect(manifest.payloads.articles?.path).toBe('articles.ndjson')
  expect(manifest.payloads.project?.checksumSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(manifest.warnings?.[0]).toMatchObject({code: 'redacted_secret', payloadKey: 'providerConnections'})
})

test('rejects unsupported project-transfer manifest schema versions', () => {
  const manifest = getValidManifest()
  const validation = validateProjectTransferManifest({
    ...manifest,
    schemaVersion: projectTransferManifestSchemaVersion + 1,
  })

  expect(validation.ok).toBe(false)
  expect(() => {
    return assertProjectTransferManifest({...manifest, schemaVersion: projectTransferManifestSchemaVersion + 1})
  }).toThrow('Unsupported project transfer manifest schema version: 2')
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
  }).toThrow('Unknown payload key: provider_connections')

  expect(() => {
    return assertProjectTransferManifest({
      ...manifest,
      payloads: {project: {...manifest.payloads.project, path: 'projects.json'}},
    })
  }).toThrow('Payload project must reference project.json')
})
