import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

const workspaceRoot = process.cwd()

const readSource = (path: string) => {
  return readFileSync(join(workspaceRoot, path), 'utf8')
}

const comparisonServingDbFiles = [
  {
    path: 'src/server/services/comparisonProjectServingGenerationService.ts',
    routeOrJobKey: 'comparisonServing.generation',
  },
  {path: 'src/server/services/comparisonProjectServingRebuildService.ts', routeOrJobKey: 'comparisonServing.rebuild'},
  {path: 'src/server/services/comparisonProjectServingCellBuilder.ts', routeOrJobKey: 'comparisonServing.cellBuilder'},
  {
    path: 'src/server/services/comparisonProjectServingRollupBuilder.ts',
    routeOrJobKey: 'comparisonServing.rollupBuilder',
  },
  {
    path: 'src/server/services/comparisonProjectServingInvalidationService.ts',
    routeOrJobKey: 'comparisonServing.invalidation',
  },
] as const

test('comparison serving builders carry owner background DuckDB workload contexts', () => {
  const helperSource = readSource('src/server/services/comparisonProjectServingWorkloadContext.ts')
  expect(helperSource).toContain("workloadClass: 'owner.comparisonServing'")
  expect(helperSource).toContain("fallbackIntent: 'reject'")

  for (const file of comparisonServingDbFiles) {
    const source = readSource(file.path)

    expect(source).toContain('getComparisonProjectServingWorkloadContext')
    expect(source).toContain(file.routeOrJobKey)
    expect(source).not.toContain('queryJson: database.queryJsonBackground,')
    expect(source).not.toContain('run: database.runBackground,')
    expect(source).not.toContain('transaction: database.transaction,')
  }
})
