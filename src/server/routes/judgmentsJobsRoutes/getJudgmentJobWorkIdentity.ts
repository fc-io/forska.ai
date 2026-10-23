import type {SystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import type {JudgmentJobWorkIdentity} from './judgmentJobHealthTypes.ts'

export const getJudgmentJobWorkIdentity = ({
  job,
  modelId,
}: {
  job: {
    fullTextStrategyId: string
    projectId: string
    systemPromptVariant: SystemPromptVariant
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    useMetadata: boolean
    useTitle: boolean
  }
  modelId: string
}): JudgmentJobWorkIdentity => {
  return {
    fullTextStrategyId: job.fullTextStrategyId,
    modelId,
    projectId: job.projectId,
    systemPromptVariant: job.systemPromptVariant,
    useAbstract: job.useAbstract,
    useFulltext: job.useFulltext,
    useFulltextNoImages: job.useFulltextNoImages,
    useMetadata: job.useMetadata,
    useTitle: job.useTitle,
  }
}
