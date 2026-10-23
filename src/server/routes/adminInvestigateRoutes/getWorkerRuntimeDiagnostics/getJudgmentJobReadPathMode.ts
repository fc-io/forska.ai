import {canCurrentServerOwnDuckdb, shouldCurrentServerRunJudgingLoops} from '../../../utils/serverRuntimeRole.ts'

type JudgmentJobReadPathMode = 'local-sqlite' | 'owner-duckdb-projection' | 'ownerless-read-only-projection'

export const getJudgmentJobReadPathMode = (): JudgmentJobReadPathMode => {
  return shouldCurrentServerRunJudgingLoops()
    ? 'local-sqlite'
    : canCurrentServerOwnDuckdb()
      ? 'owner-duckdb-projection'
      : 'ownerless-read-only-projection'
}
