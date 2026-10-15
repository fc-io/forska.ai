import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {reviewServingInterruptionEvidence} from './reviewServingInterruptionEvidence.ts'

const repoRoot = join(import.meta.dir, '../../..')

const getSource = (filePath: string) => {
  return readFileSync(join(repoRoot, filePath), 'utf8')
}

test('interruption evidence covers every resume area', () => {
  expect(
    reviewServingInterruptionEvidence.map((entry) => {
      return entry.area
    }),
  ).toEqual(['projectorResume', 'bulkJobResume', 'searchJobResume', 'cleanupResume', 'lowMemoryDefaults'])
})

test('interruption evidence markers stay present in source and tests', () => {
  reviewServingInterruptionEvidence.map((entry) => {
    const sources = entry.evidenceFiles.map(getSource).join('\n')

    entry.requiredMarkers.map((marker) => {
      expect(sources).toContain(marker)
      return marker
    })

    return entry
  })
})
