import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test'
import {Window} from 'happy-dom'

import type {ComparisonProjectConflictResolutionExportResult} from '../../../../../services/comparisonProjectsService.ts'

const comparisonProjectsServiceModulePath = new URL(
  '../../../../../services/comparisonProjectsService.ts',
  import.meta.url,
).pathname
const fetchComparisonProjectConflictResolutionExportArtifact = mock(
  async (_comparisonProjectId: string): Promise<ComparisonProjectConflictResolutionExportResult> => {
    return exportResult
  },
)

void mock.module(comparisonProjectsServiceModulePath, () => {
  return {fetchComparisonProjectConflictResolutionExportArtifact}
})

const testWindow = new Window({url: 'http://localhost:3000'})

Object.assign(globalThis, {
  HTMLAnchorElement: testWindow.HTMLAnchorElement,
  document: testWindow.document,
  window: testWindow,
})

const {compareProjectResolutionImportDisabledCopy, getImportResolutionsHref, handleExportResolutionsClick} =
  require('./compareProjectResolutionTransferActions.tsx') as typeof import('./compareProjectResolutionTransferActions.tsx')

const originalCreateObjectURL = Reflect.get(URL, 'createObjectURL')
const originalRevokeObjectURL = Reflect.get(URL, 'revokeObjectURL')
const originalAnchorClickDescriptor = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'click') ?? {
  configurable: true,
  value: () => {},
}
let anchorClickMock: typeof HTMLAnchorElement.prototype.click
let clickedAnchors: HTMLAnchorElement[] = []
let createObjectURLMock: typeof URL.createObjectURL & {mock: {calls: Array<[Blob | MediaSource]>}}
let revokeObjectURLMock: typeof URL.revokeObjectURL

const transferArtifact = {
  exportedAt: '2026-06-10T12:00:00.000Z',
  format: 'forska.comparisonProject.conflictResolution.transfer',
  rows: [
    {
      externalArticleId: 'external-1',
      identifiers: [],
      resolution: {label: 'Yes', mode: 'summary', value: 'yes'},
      sourceArticleRowId: 'article-1',
      sourceResolutionId: 'resolution-1',
      title: 'Article 1',
    },
  ],
  source: {
    comparisonProjectDescription: null,
    comparisonProjectId: 'source-comparison-project-1',
    comparisonProjectName: 'Source comparison',
  },
  version: 1,
} as const

let exportResult: ComparisonProjectConflictResolutionExportResult = {
  artifact: transferArtifact,
  filename: 'source-conflict-resolutions.json',
}

beforeEach(() => {
  document.body.innerHTML = ''
  fetchComparisonProjectConflictResolutionExportArtifact.mockClear()
  exportResult = {artifact: transferArtifact, filename: 'source-conflict-resolutions.json'}
  clickedAnchors = []
  createObjectURLMock = mock((_object: Blob | MediaSource) => {
    return 'blob:conflict-resolution-transfer'
  }) as unknown as typeof createObjectURLMock
  revokeObjectURLMock = mock((_objectUrl: string) => {}) as unknown as typeof URL.revokeObjectURL
  anchorClickMock = mock(function (this: HTMLAnchorElement) {
    clickedAnchors.push(this)
  }) as unknown as typeof HTMLAnchorElement.prototype.click
  Object.defineProperty(URL, 'createObjectURL', {configurable: true, value: createObjectURLMock})
  Object.defineProperty(URL, 'revokeObjectURL', {configurable: true, value: revokeObjectURLMock})
  Object.defineProperty(HTMLAnchorElement.prototype, 'click', {configurable: true, value: anchorClickMock})
})

afterEach(() => {
  document.body.innerHTML = ''
  Object.defineProperty(URL, 'createObjectURL', {configurable: true, value: originalCreateObjectURL})
  Object.defineProperty(URL, 'revokeObjectURL', {configurable: true, value: originalRevokeObjectURL})
  Object.defineProperty(HTMLAnchorElement.prototype, 'click', originalAnchorClickDescriptor)
})

describe('compare detail resolution transfer actions', () => {
  test('downloads the exported resolution artifact as JSON', async () => {
    const exportErrors: Array<string | null> = []
    const exportingStates: boolean[] = []

    await handleExportResolutionsClick({
      comparisonProjectId: 'comparison-project-1',
      setExportError: (message) => {
        exportErrors.push(message)
      },
      setIsExporting: (isExporting) => {
        exportingStates.push(isExporting)
      },
    })

    const blob = createObjectURLMock.mock.calls[0]?.[0]
    const clickedAnchor = clickedAnchors[0]

    expect(fetchComparisonProjectConflictResolutionExportArtifact).toHaveBeenCalledWith('comparison-project-1')
    expect(exportErrors).toEqual([null])
    expect(exportingStates).toEqual([true, false])
    expect(anchorClickMock).toHaveBeenCalled()
    expect(blob).toBeInstanceOf(Blob)
    expect(blob instanceof Blob ? blob.type : null).toContain('application/json')
    expect(blob instanceof Blob ? await blob.text() : null).toBe(JSON.stringify(transferArtifact, null, 2))
    expect(clickedAnchor.download).toBe('source-conflict-resolutions.json')
    expect(clickedAnchor.href).toBe('blob:conflict-resolution-transfer')
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:conflict-resolution-transfer')
  })

  test('builds the import resolutions entry point href', () => {
    expect(getImportResolutionsHref('comparison-project-1')).toBe(
      '/compare-judgments/comparison-project-1/import-resolutions',
    )
  })

  test('keeps disabled import copy explicit', () => {
    expect(compareProjectResolutionImportDisabledCopy).toBe(
      'Target comparison project must allow conflict resolution to import resolutions.',
    )
  })
})
