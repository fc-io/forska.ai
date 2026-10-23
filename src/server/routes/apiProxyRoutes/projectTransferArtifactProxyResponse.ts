import type {DuckdbOwnerProxyRequestTemplate} from './duckdbOwnerProxyRequestTemplate.ts'
import {getPublicDuckdbOwnerProxyPathname} from './getPublicDuckdbOwnerProxyPathname.ts'

export const getImportSessionIdFromProxyPathname = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  if (requestTemplate.method !== 'GET') {
    return null
  }

  const publicPathname = getPublicDuckdbOwnerProxyPathname(requestTemplate)
  const match = publicPathname.match(/^\/api\/projects\/import\/([^/]+)$/)

  if (match === null) {
    return null
  }

  try {
    return decodeURIComponent(match[1] ?? '')
  } catch {
    return null
  }
}

const getExportSessionIdFromProxyPathname = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  if (requestTemplate.method !== 'GET') {
    return null
  }

  const publicPathname = getPublicDuckdbOwnerProxyPathname(requestTemplate)
  const match = publicPathname.match(/^\/api\/projects\/export\/([^/]+)$/)

  if (match === null) {
    return null
  }

  try {
    return decodeURIComponent(match[1] ?? '')
  } catch {
    return null
  }
}

const getProjectTransferImportArtifactProxyResponse = async (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  const sessionId = getImportSessionIdFromProxyPathname(requestTemplate)

  if (sessionId === null) {
    return null
  }

  const {getImportSessionArtifactResponse, shouldUseImportSessionArtifactResponse} =
    await import('../projectTransferRoutes.ts')
  const artifactResponse = await getImportSessionArtifactResponse(sessionId)

  return artifactResponse === null
    || artifactResponse.data === null
    || artifactResponse.data.state === 'failed'
    || !shouldUseImportSessionArtifactResponse(artifactResponse)
    ? null
    : Response.json(artifactResponse)
}

export const getProjectTransferImportArtifactFallbackProxyResponse = async (
  requestTemplate: DuckdbOwnerProxyRequestTemplate,
) => {
  const sessionId = getImportSessionIdFromProxyPathname(requestTemplate)

  if (sessionId === null) {
    return null
  }

  const {getImportSessionArtifactResponse, shouldUseImportSessionArtifactResponse} =
    await import('../projectTransferRoutes.ts')
  const artifactResponse = await getImportSessionArtifactResponse(sessionId)

  return artifactResponse === null
    || artifactResponse.data === null
    || (artifactResponse.data.state !== 'failed' && shouldUseImportSessionArtifactResponse(artifactResponse))
    ? null
    : Response.json(artifactResponse)
}

const getProjectTransferExportArtifactProxyResponse = async (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  const exportId = getExportSessionIdFromProxyPathname(requestTemplate)

  if (exportId === null) {
    return null
  }

  const {getExportSessionArtifactResponse} = await import('../projectTransferRoutes.ts')
  const routeSet: {status?: number | string} = {}
  const artifactResponse = await getExportSessionArtifactResponse(routeSet, exportId)

  return artifactResponse === null
    ? null
    : Response.json(artifactResponse, {status: typeof routeSet.status === 'number' ? routeSet.status : undefined})
}

export const getProjectTransferArtifactProxyResponse = async (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  return (
    (await getProjectTransferImportArtifactProxyResponse(requestTemplate))
    ?? (await getProjectTransferExportArtifactProxyResponse(requestTemplate))
  )
}

export const getImportArtifactFallbackForOwnerFailure = (
  ownerResponse: Response | null,
  artifactResponse: Response | null,
) => {
  return artifactResponse !== null
    && (ownerResponse === null
      || ownerResponse.status === 502
      || ownerResponse.status === 503
      || ownerResponse.status === 504)
    ? artifactResponse
    : ownerResponse
}
