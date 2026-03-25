import {
  getComparableModelNames,
  getRuntimeModelNamesForProvider,
  hasRuntimeModelMatch,
} from './providerRuntimeModelMatch.ts'

type RuntimeSummaryLike = {activeModelNames: string[]; providerKind: string | null}

type RuntimeModelNotice = {message: string; tone: 'info' | 'warning'}

const getNormalizedProviderKind = (value: string | null | undefined): string => {
  return String(value ?? '')
    .trim()
    .toLowerCase()
}

export const getSglangRuntimeModelNotice = ({
  candidateModelNames,
  getMismatchMessage,
  providerKind,
  runtime,
}: {
  candidateModelNames: Array<string | null | undefined>
  getMismatchMessage: (runtimeLabel: string) => string
  providerKind: string | null | undefined
  runtime: RuntimeSummaryLike | null | undefined
}): RuntimeModelNotice | null => {
  const normalizedProviderKind = getNormalizedProviderKind(providerKind)
  const normalizedRuntimeProviderKind = getNormalizedProviderKind(runtime?.providerKind)
  const runtimeModelNames = getRuntimeModelNamesForProvider({providerKind, runtime})
  const runtimeLabel = runtimeModelNames.join(', ')

  if (normalizedProviderKind !== 'sglang' || normalizedRuntimeProviderKind !== 'sglang') {
    return null
  }

  if (runtimeModelNames.length === 0) {
    return {
      message:
        'Active SGLang runtime detected, but its model name is unavailable. Job start still checks the live runtime before running.',
      tone: 'info',
    }
  }

  return hasRuntimeModelMatch({
    candidateModelNames: getComparableModelNames(candidateModelNames),
    providerKind,
    runtime,
  })
    ? {message: `Active SGLang runtime model: ${runtimeLabel}.`, tone: 'info'}
    : {message: getMismatchMessage(runtimeLabel), tone: 'warning'}
}
