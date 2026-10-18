import type {FullTextFigureMode} from '../../../../utils/fullTextStrategyOptions.ts'
import type {FullTextStrategyChoice} from './fullTextStrategyChoiceGroup.tsx'

export type ModelImageInput = {acceptsImages: boolean; modelId: string; modelLabel: string}

export const getFigureModeChoices = (
  nativeImagesDisabled: boolean,
): ReadonlyArray<FullTextStrategyChoice<FullTextFigureMode>> => {
  return [
    {
      description: 'Figure captions stay in the text. Figure images are not sent.',
      label: 'Text only (figures reduced to their captions)',
      value: 'none',
    },
    {
      description: 'Each figure is sent as an image after its caption. Needs a model that accepts image input.',
      disabled: nativeImagesDisabled,
      label: 'Include figures as images',
      value: 'native_images',
    },
  ]
}

export const getCurrentModelImageInput = (stored: ModelImageInput | null, modelId: string): ModelImageInput | null => {
  return stored && modelId !== '' && stored.modelId === modelId ? stored : null
}

export const getModelImageInputWarning = (input: ModelImageInput | null): string | null => {
  return input?.acceptsImages === false
    ? `Model ${input.modelLabel} cannot receive images. Figures will be reduced to their captions (text only).`
    : null
}
