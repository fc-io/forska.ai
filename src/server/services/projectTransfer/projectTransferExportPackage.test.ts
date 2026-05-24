import {afterAll, beforeEach, expect, mock, test} from 'bun:test'

import type {ProjectTransferSessionRecord} from '../../../db/schemaTypes.ts'
import {projectTransferExecutionThresholds} from './projectTransferContracts.ts'

const exportModulePath = new URL('./projectTransferExport.ts', import.meta.url).pathname
const sessionRepositoryModulePath = new URL('./projectTransferSessionRepository.ts', import.meta.url).pathname

const now = new Date('2026-05-24T08:00:00.000Z')
const expiresAt = new Date('2026-05-25T08:00:00.000Z')
const sessionRecord: ProjectTransferSessionRecord = {
  commitId: null,
  completionPayloadJson: null,
  createdAt: now,
  direction: 'export',
  errorJson: null,
  expiresAt,
  heartbeatAt: null,
  id: 'export-large',
  ownerToken: null,
  packageFingerprint: null,
  planRevision: 0,
  planSummaryJson: null,
  progressJson: null,
  state: 'queued',
  terminalCleanupAt: null,
  updatedAt: now,
}

const getProjectTransferExportPayloadsMock = mock(async () => {
  throw new Error('Payload assembly should run in the export worker only')
})
const getProjectTransferExportPreflightEstimateMock = mock(async () => {
  return {assetBytes: projectTransferExecutionThresholds.exportInlineAssetBytes + 1, packageBytes: 0}
})
const createProjectTransferSessionMock = mock(async () => {
  return sessionRecord
})
const claimProjectTransferExportSessionOwnerMock = mock(async () => {
  return null
})

void mock.module(exportModulePath, () => {
  return {
    getProjectTransferExportPayloads: getProjectTransferExportPayloadsMock,
    getProjectTransferExportPreflightEstimate: getProjectTransferExportPreflightEstimateMock,
    serializeProjectTransferExportPayloads: () => {
      return {}
    },
  }
})

void mock.module(sessionRepositoryModulePath, () => {
  return {
    getProjectTransferSessionRepository: () => {
      return {
        claimProjectTransferExportSessionOwner: claimProjectTransferExportSessionOwnerMock,
        createProjectTransferSession: createProjectTransferSessionMock,
      }
    },
  }
})

const loadProjectTransferExportPackage = async (): Promise<typeof import('./projectTransferExportPackage.ts')> => {
  return (await import(
    `./projectTransferExportPackage.ts?test=${Date.now()}-${Math.random()}`
  )) as typeof import('./projectTransferExportPackage.ts')
}

beforeEach(() => {
  getProjectTransferExportPayloadsMock.mockClear()
  getProjectTransferExportPreflightEstimateMock.mockClear()
  createProjectTransferSessionMock.mockClear()
  claimProjectTransferExportSessionOwnerMock.mockClear()
})

afterAll(() => {
  mock.restore()
})

test('project-transfer export queues background sessions before payload assembly', async () => {
  const {createProjectTransferExport} = await loadProjectTransferExportPackage()

  const result = await createProjectTransferExport({
    expiresAt,
    exportedAt: now,
    projectId: 'project-large',
    sessionId: 'export-large',
  })

  expect(result.executionMode).toBe('background')
  expect(result.sessionId).toBe('export-large')
  expect(result.metadata.downloadUrl).toBe('/api/projects/export/export-large/download')
  expect(createProjectTransferSessionMock).toHaveBeenCalledWith({
    direction: 'export',
    expiresAt,
    id: 'export-large',
    state: 'queued',
  })
  expect(claimProjectTransferExportSessionOwnerMock).toHaveBeenCalled()
  expect(getProjectTransferExportPayloadsMock).not.toHaveBeenCalled()
})
