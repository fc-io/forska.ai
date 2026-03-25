type ProviderRuntimeSummaryLike = {activeModelNames: string[]; providerKind: string | null}

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getNormalizedProviderKind = (value: string | null | undefined): string | null => {
  const normalized = getTrimmedValue(value)?.toLowerCase() ?? null

  return normalized && normalized.length > 0 ? normalized : null
}

export const getComparableModelNames = (values: Array<string | null | undefined>): string[] => {
  return Array.from(
    new Set(
      values.flatMap((value) => {
        const normalized = getTrimmedValue(value)

        return normalized ? [normalized] : []
      }),
    ),
  )
}

export const getRuntimeModelNamesForProvider = ({
  providerKind,
  runtime,
}: {
  providerKind: string | null | undefined
  runtime: ProviderRuntimeSummaryLike | null | undefined
}): string[] => {
  const normalizedProviderKind = getNormalizedProviderKind(providerKind)
  const normalizedRuntimeProviderKind = getNormalizedProviderKind(runtime?.providerKind)

  return normalizedProviderKind && normalizedProviderKind === normalizedRuntimeProviderKind
    ? getComparableModelNames(runtime?.activeModelNames ?? [])
    : []
}

export const hasRuntimeModelMatch = ({
  candidateModelNames,
  providerKind,
  runtime,
}: {
  candidateModelNames: Array<string | null | undefined>
  providerKind: string | null | undefined
  runtime: ProviderRuntimeSummaryLike | null | undefined
}): boolean => {
  const comparableCandidateModelNames = getComparableModelNames(candidateModelNames)
  const runtimeModelNames = getRuntimeModelNamesForProvider({providerKind, runtime})

  return comparableCandidateModelNames.some((candidateModelName) => {
    return runtimeModelNames.includes(candidateModelName)
  })
}
