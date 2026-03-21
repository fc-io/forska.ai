import {inferenceRuntimeConfig} from '../../utils/getInferenceRuntimeConfig.ts'

export const getCodexMaxInflight = (): number => {
  return Math.max(1, inferenceRuntimeConfig.codexMaxInflight)
}
