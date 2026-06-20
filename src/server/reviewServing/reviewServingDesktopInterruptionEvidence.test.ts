import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {reviewServingDesktopInterruptionEvidence} from './reviewServingDesktopInterruptionEvidence.ts'

const repoRoot = join(import.meta.dir, '../../..')

const getSource = (filePath: string) => {
  return readFileSync(join(repoRoot, filePath), 'utf8')
}

test('desktop and interruption evidence covers every Phase 5 Part 2 area', () => {
  expect(
    reviewServingDesktopInterruptionEvidence.map((entry) => {
      return entry.area
    }),
  ).toEqual([
    'browserDesktopParity',
    'browserDesktopParity',
    'projectorResume',
    'bulkJobResume',
    'searchJobResume',
    'cleanupResume',
    'lowMemoryDefaults',
  ])
})

test('desktop and interruption evidence markers stay present in source and tests', () => {
  reviewServingDesktopInterruptionEvidence.map((entry) => {
    const sources = entry.evidenceFiles.map(getSource).join('\n')

    entry.requiredMarkers.map((marker) => {
      expect(sources).toContain(marker)
      return marker
    })

    return entry
  })
})
