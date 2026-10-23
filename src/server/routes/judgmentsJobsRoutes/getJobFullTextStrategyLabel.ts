import {getLegacyNoImagesAwareFullTextStrategyLabel} from '../../../utils/legacyFullTextNoImagesLabel.ts'

export const getJobFullTextStrategyLabel = (
  job: {fullTextStrategyId: string; useFulltextNoImages?: boolean | null},
  fullTextStrategyLabelsById: Map<string, string>,
) => {
  return getLegacyNoImagesAwareFullTextStrategyLabel({
    label: fullTextStrategyLabelsById.get(job.fullTextStrategyId) ?? job.fullTextStrategyId,
    useFulltextNoImages: job.useFulltextNoImages,
  })
}
