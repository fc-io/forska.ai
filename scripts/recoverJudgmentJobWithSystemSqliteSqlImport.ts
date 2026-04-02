import {recoverJudgmentJobWithSystemSqlite} from './recoverJudgmentJobWithSystemSqlite.ts'

export const recoverJudgmentJobWithSystemSqliteSqlImport = async () => {
  return recoverJudgmentJobWithSystemSqlite()
}

if (import.meta.main) {
  await recoverJudgmentJobWithSystemSqliteSqlImport()
}
