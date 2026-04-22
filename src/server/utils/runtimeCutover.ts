export const splitRuntimeCutoverVersion = 'split-runtime-v1'
export const splitRuntimeCutoverVersionHeader = 'x-forska-runtime-version'

export type RuntimeCutoverProbeResult =
  | {runtimeVersion: string; status: 'compatible'}
  | {message: string; runtimeVersion: string | null; status: 'incompatible'}
  | {error: unknown; status: 'unreachable'}

const getTrimmedValue = (value: string | null | undefined) => {
  const normalizedValue = String(value ?? '').trim()

  return normalizedValue === '' ? null : normalizedValue
}

const getObjectValue = (value: unknown): Record<string, unknown> | null => {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

const getStringProperty = (value: unknown, key: string) => {
  const objectValue = getObjectValue(value)
  const propertyValue = objectValue?.[key]

  return typeof propertyValue === 'string' ? propertyValue : null
}

const readResponseJson = async (response: Response) => {
  const parsed = (await response.json().catch(() => {
    return null
  })) as unknown

  return parsed
}

export const getRuntimeCutoverVersion = () => {
  return splitRuntimeCutoverVersion
}

export const normalizeRuntimeCutoverVersion = (value: string | null | undefined) => {
  return getTrimmedValue(value)
}

export const isRuntimeCutoverVersionCompatible = (value: string | null | undefined) => {
  return normalizeRuntimeCutoverVersion(value) === splitRuntimeCutoverVersion
}

export const getRuntimeCutoverVersionMismatchMessage = ({
  context,
  runtimeVersion,
}: {
  context: string
  runtimeVersion: string | null | undefined
}) => {
  return `Incompatible Forska split runtime version for ${context}: expected ${splitRuntimeCutoverVersion}, received ${normalizeRuntimeCutoverVersion(runtimeVersion) ?? 'pre-cutover/missing'}. Stop the pre-cutover peer before running the split runtime.`
}

export const assertRuntimeCutoverVersionCompatible = ({
  context,
  runtimeVersion,
}: {
  context: string
  runtimeVersion: string | null | undefined
}) => {
  if (isRuntimeCutoverVersionCompatible(runtimeVersion)) {
    return
  }

  throw new Error(getRuntimeCutoverVersionMismatchMessage({context, runtimeVersion}))
}

export const getRuntimeCutoverVersionFromPeerResponse = (value: unknown) => {
  const data = getObjectValue(getObjectValue(value)?.data)
  const owner = getObjectValue(data?.owner)
  const ownerRuntimeVersion = getStringProperty(owner, 'runtimeVersion')
  const dataRuntimeVersion = getStringProperty(data, 'runtimeVersion')

  return ownerRuntimeVersion ?? dataRuntimeVersion
}

export const probeDuckdbOwnerCutoverCompatibility = async (
  duckdbOwnerUrl: string,
  context: string,
): Promise<RuntimeCutoverProbeResult> => {
  try {
    const response = await fetch(`${duckdbOwnerUrl}/api/duckdb_owner_connections`, {signal: AbortSignal.timeout(1_000)})
    const runtimeVersion = getRuntimeCutoverVersionFromPeerResponse(await readResponseJson(response))

    return isRuntimeCutoverVersionCompatible(runtimeVersion)
      ? {runtimeVersion: splitRuntimeCutoverVersion, status: 'compatible'}
      : {
          message: getRuntimeCutoverVersionMismatchMessage({context, runtimeVersion}),
          runtimeVersion,
          status: 'incompatible',
        }
  } catch (error) {
    return {error, status: 'unreachable'}
  }
}

export const assertReachableDuckdbOwnerCutoverCompatible = async (duckdbOwnerUrl: string, context: string) => {
  const result = await probeDuckdbOwnerCutoverCompatibility(duckdbOwnerUrl, context)

  if (result.status === 'incompatible') {
    throw new Error(result.message)
  }

  return result
}
