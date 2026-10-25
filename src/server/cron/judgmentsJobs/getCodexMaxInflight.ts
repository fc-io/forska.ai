import {getInferenceRuntimeConfig} from '../../utils/getInferenceRuntimeConfig.ts'

const codexDefaultMaxInflight = 35

export const getCodexMaxInflight = (): number => {
  const configured = getInferenceRuntimeConfig().codexMaxInflight

  return Number.isFinite(configured) && configured >= 1 ? Math.trunc(configured) : codexDefaultMaxInflight
}
