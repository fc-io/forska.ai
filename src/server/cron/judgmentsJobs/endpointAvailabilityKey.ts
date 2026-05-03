import {getNormalizedProviderKeyProvider, getProviderKey, type ProviderKeyInput} from './providerKey.ts'

export type EndpointAvailabilityKeyInput = ProviderKeyInput & {effectiveBaseURL: string; providerKey?: string | null}

export type EndpointAvailabilityKey = {
  endpointAvailabilityKey: string
  endpointIdentity: string
  misconfiguration: string | null
  providerKey: string
  shouldSkipHttpProbe: boolean
}

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const trimmed = String(value ?? '').trim()

  return trimmed.length > 0 ? trimmed : null
}

const isDefaultPort = ({port, scheme}: {port: string; scheme: string}): boolean => {
  return (scheme === 'http' && port === '80') || (scheme === 'https' && port === '443')
}

const getMeaningfulPath = (pathname: string): string => {
  const withoutTrailingSlashes = pathname.replace(/\/+$/, '')
  const segments = withoutTrailingSlashes.split('/').filter((segment) => {
    return segment.length > 0
  })
  const meaningfulSegments =
    segments.at(-1)?.toLowerCase() === 'v1' ? segments.slice(0, Math.max(0, segments.length - 1)) : segments

  return meaningfulSegments.length > 0 ? `/${meaningfulSegments.join('/')}` : ''
}

const getEndpointIdentityMisconfiguration = (url: URL): string | null => {
  return url.username || url.password
    ? 'Endpoint base URL is misconfigured because credentials are not allowed'
    : url.search
      ? 'Endpoint base URL is misconfigured because query strings are not allowed'
      : url.hash
        ? 'Endpoint base URL is misconfigured because fragments are not allowed'
        : null
}

const getHttpEndpointIdentity = (url: URL): string => {
  const scheme = url.protocol.slice(0, -1).toLowerCase()
  const host = url.hostname.toLowerCase()
  const port = url.port && !isDefaultPort({port: url.port, scheme}) ? `:${url.port}` : ''
  const path = getMeaningfulPath(url.pathname)

  return `${scheme}://${host}${port}${path}`
}

const getCodexEndpointIdentity = (url: URL): {identity: string; misconfiguration: string | null} => {
  const host = url.hostname.toLowerCase()
  const hasPath = getMeaningfulPath(url.pathname).length > 0
  const misconfiguration =
    host !== 'app-server' || hasPath
      ? 'Endpoint base URL is misconfigured because Codex app-server uses codex://app-server'
      : null

  return {identity: 'codex://app-server', misconfiguration}
}

const getEndpointIdentity = (effectiveBaseURL: string): {identity: string; misconfiguration: string | null} => {
  const trimmed = getTrimmedValue(effectiveBaseURL)

  if (!trimmed) {
    return {identity: 'misconfigured:empty', misconfiguration: 'Endpoint base URL is required'}
  }

  try {
    const url = new URL(trimmed)
    const scheme = url.protocol.slice(0, -1).toLowerCase()
    const misconfiguration = getEndpointIdentityMisconfiguration(url)
    const codexEndpointIdentity = getCodexEndpointIdentity(url)

    return scheme === 'codex'
      ? {...codexEndpointIdentity, misconfiguration: misconfiguration ?? codexEndpointIdentity.misconfiguration}
      : scheme === 'http' || scheme === 'https'
        ? {identity: getHttpEndpointIdentity(url), misconfiguration}
        : {
            identity: `${scheme}://${url.host.toLowerCase()}${getMeaningfulPath(url.pathname)}`,
            misconfiguration: `Endpoint base URL is misconfigured because ${scheme} URLs are not supported`,
          }
  } catch {
    return {
      identity: `misconfigured:${trimmed}`,
      misconfiguration: 'Endpoint base URL is misconfigured because it is not an absolute URL',
    }
  }
}

const getEndpointAvailabilityProviderKey = ({
  modelId,
  modelProvider,
  providerConnectionId,
  providerKey,
  useOwnerBackedSyntheticProviderId,
}: EndpointAvailabilityKeyInput): string => {
  return (
    getTrimmedValue(providerKey)
    ?? getProviderKey({modelId, modelProvider, providerConnectionId, useOwnerBackedSyntheticProviderId})
  )
}

export const getEndpointAvailabilityKey = (input: EndpointAvailabilityKeyInput): EndpointAvailabilityKey => {
  const providerKey = getEndpointAvailabilityProviderKey(input)
  const endpointIdentity = getEndpointIdentity(input.effectiveBaseURL)
  const provider = getNormalizedProviderKeyProvider(input.modelProvider)
  const shouldSkipHttpProbe =
    endpointIdentity.identity === 'codex://app-server' && (provider === 'codex' || providerKey === 'codex:default')

  return {
    endpointAvailabilityKey: `${providerKey}::${endpointIdentity.identity}`,
    endpointIdentity: endpointIdentity.identity,
    misconfiguration: endpointIdentity.misconfiguration,
    providerKey,
    shouldSkipHttpProbe,
  }
}

export const shouldSkipEndpointAvailabilityHttpProbe = (input: EndpointAvailabilityKeyInput): boolean => {
  return getEndpointAvailabilityKey(input).shouldSkipHttpProbe
}
