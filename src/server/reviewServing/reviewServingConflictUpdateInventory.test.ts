import {join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()

type ConflictUpdateInventoryEntry = {path: string; reason: string; snippet: string}

const allowedConflictUpdates: ConflictUpdateInventoryEntry[] = [
  {
    path: 'src/server/reviewServing/reviewServingChunkManifestRepository.ts',
    reason: 'chunk manifest upserts preserve leases, attempts, diagnostics, and active chunk state',
    snippet: 'ON CONFLICT(chunk_id) DO UPDATE SET',
  },
  {
    path: 'src/server/reviewServing/reviewServingSummaryProjector.ts',
    reason: 'summary rebuild accumulator adds chunk partial totals across batches',
    snippet:
      'ON CONFLICT(request_id, chunk_id, project_id, review_config_hash, snapshot_id, serving_key) DO UPDATE SET',
  },
  {
    path: 'src/server/reviewServing/reviewServingProjectorWriter.ts',
    reason: 'generic writer fallback remains for non-allowlisted tables without a scoped replacement proof',
    snippet: 'DO UPDATE SET ${assignments.join',
  },
]

const readSource = async (path: string) => {
  return globalThis.Bun.file(join(projectRoot, path)).text()
}

test('review-serving conflict-update sites stay explicitly inventoried', async () => {
  const result = globalThis.Bun.spawnSync([
    'rg',
    '-n',
    'DO UPDATE SET',
    'src/server/reviewServing',
    'src/server/workers',
    '-g',
    '*.ts',
    '-g',
    '!*.test.ts',
  ])
  const output = result.stdout.toString().trim()
  const actualPaths = [
    ...new Set(
      output
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          return line.split(':')[0]
        }),
    ),
  ].sort()
  const expectedPaths = allowedConflictUpdates
    .map((entry) => {
      return entry.path
    })
    .sort()

  expect(actualPaths).toEqual(expectedPaths)

  for (const entry of allowedConflictUpdates) {
    const source = await readSource(entry.path)

    expect(entry.reason.length > 20).toBe(true)
    expect(source).toContain(entry.snippet)
  }
})
