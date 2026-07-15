import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

const readSource = (path: string) => {
  return readFileSync(path, 'utf8')
}

test('judgment persistence DuckDB calls carry background workload contexts', () => {
  const storeSinglePromptSource = readSource('src/agent/judge/storeSinglePromptJudgment.ts')
  const legacyStoreSource = readSource('src/agent/judge/judgeStoreJudgment.ts')

  expect(storeSinglePromptSource).toContain('singlePromptJudgmentPersistenceWorkloadContext')
  expect(storeSinglePromptSource).toContain("workloadClass: 'background.judgmentPersistence'")
  expect(storeSinglePromptSource).toContain("routeOrJobKey: 'judge.storeSinglePromptJudgment.persistence'")
  expect(storeSinglePromptSource).toContain('maxResultRows: 1')

  expect(legacyStoreSource).toContain('legacyJudgmentPersistenceWorkloadContext')
  expect(legacyStoreSource).toContain('legacyJudgmentPersistenceLookupWorkloadContext')
  expect(legacyStoreSource).toContain("routeOrJobKey: 'judge.storeJudgment.legacyPersistence.lookup'")
  expect(legacyStoreSource).toContain("workloadClass: 'background.judgmentPersistence'")
})
