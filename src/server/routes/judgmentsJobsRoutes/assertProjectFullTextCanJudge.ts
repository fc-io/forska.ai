import {assertProjectFullTextJudgable} from '../../services/judgmentJobFullTextGate.ts'
import {assertProjectFullTextArticlesMatchStrategy} from '../../services/judgmentJobFullTextReconversion.ts'

export const assertProjectFullTextCanJudge = async (projectId: string): Promise<void> => {
  const gate = await assertProjectFullTextJudgable(projectId)

  return assertProjectFullTextArticlesMatchStrategy({projectId, strategy: gate.strategy})
}
