export const legacyFullTextNoImagesLabel = 'full text (legacy, no images)'

export const getLegacyNoImagesAwareFullTextStrategyLabel = (input: {
  label: string
  useFulltextNoImages: boolean | null | undefined
}) => {
  return input.useFulltextNoImages === true ? legacyFullTextNoImagesLabel : input.label
}
