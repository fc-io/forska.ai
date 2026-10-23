import {shouldCurrentServerProxyApiToOwner} from '../../utils/serverRuntimeRole.ts'
import {duckdbOwnerProxyLogger} from './duckdbOwnerProxyLogger.ts'
import {
  type DuckdbOwnerStreamingProxyRequestTemplate,
  getDuckdbOwnerProxyRequestTemplate,
  getDuckdbOwnerStreamingProxyRequestTemplate,
} from './duckdbOwnerProxyRequestTemplate.ts'
import {getDuckdbOwnerProxyFailureResponse, getDuckdbOwnerProxyResponse} from './duckdbOwnerProxyResponses.ts'
import {warnDuckdbOwnerProxyFailure, warnDuckdbOwnerProxyOwnerErrorResponse} from './duckdbOwnerProxyWarnings.ts'
import {fetchDuckdbOwnerStreamingProxyResponse} from './fetchDuckdbOwnerProxyResponse.ts'
import {
  fetchNonRetryableDuckdbOwnerProxyResponse,
  fetchRetryableDuckdbOwnerProxyResponse,
  getRetriedProxyResponse,
  shouldRetryDuckdbOwnerProxyRequest,
} from './forwardApiRequestToDuckdbOwner/duckdbOwnerProxyRetry.ts'
import {getDuckdbOwnerProxyTargetFailureResponse} from './forwardApiRequestToDuckdbOwner/getDuckdbOwnerProxyTargetFailureResponse.ts'
import {getDuckdbOwnerProxyErrorMessage} from './getDuckdbOwnerProxyErrorMessage.ts'
import {
  getImportArtifactFallbackForOwnerFailure,
  getProjectTransferArtifactProxyResponse,
  getProjectTransferImportArtifactFallbackProxyResponse,
} from './projectTransferArtifactProxyResponse.ts'

const forwardStreamingApiRequestToDuckdbOwner = async (
  requestTemplate: DuckdbOwnerStreamingProxyRequestTemplate,
): Promise<Response | null> => {
  const target = await getDuckdbOwnerProxyTargetFailureResponse(requestTemplate)

  if ('response' in target) {
    return target.response
  }

  try {
    return getDuckdbOwnerProxyResponse(
      await fetchDuckdbOwnerStreamingProxyResponse(requestTemplate, target.duckdbOwnerUrl),
    )
  } catch (error) {
    duckdbOwnerProxyLogger.warn(
      'api-proxy:duckdb-owner-streaming-forward-failed',
      '[api-proxy] DuckDB owner proxy streaming forward failed',
      {
        classification: requestTemplate.classification,
        duckdbOwnerUrl: target.duckdbOwnerUrl,
        error: getDuckdbOwnerProxyErrorMessage(error),
        method: requestTemplate.method,
        pathname: requestTemplate.pathname,
        search: requestTemplate.search,
      },
    )
    return getDuckdbOwnerProxyFailureResponse(requestTemplate)
  }
}

const forwardBufferedApiRequestToDuckdbOwner = async (request: Request): Promise<Response | null> => {
  const requestTemplate = await getDuckdbOwnerProxyRequestTemplate(request)

  if (requestTemplate === null) {
    return null
  }

  const artifactResponse = await getProjectTransferArtifactProxyResponse(requestTemplate)

  if (artifactResponse !== null) {
    return artifactResponse
  }

  const importArtifactFallbackResponse = await getProjectTransferImportArtifactFallbackProxyResponse(requestTemplate)

  const target = await getDuckdbOwnerProxyTargetFailureResponse(requestTemplate)

  if ('response' in target) {
    return getImportArtifactFallbackForOwnerFailure(target.response, importArtifactFallbackResponse)
  }

  const shouldRetryProxyRequest = shouldRetryDuckdbOwnerProxyRequest(requestTemplate)

  try {
    const response = shouldRetryProxyRequest
      ? await fetchRetryableDuckdbOwnerProxyResponse(requestTemplate, target.duckdbOwnerUrl)
      : await fetchNonRetryableDuckdbOwnerProxyResponse(requestTemplate, target.duckdbOwnerUrl)

    await warnDuckdbOwnerProxyOwnerErrorResponse(requestTemplate, response, target.duckdbOwnerUrl)
    const ownerResponse = getDuckdbOwnerProxyResponse(response)

    return getImportArtifactFallbackForOwnerFailure(ownerResponse, importArtifactFallbackResponse)
  } catch (error) {
    warnDuckdbOwnerProxyFailure('api-proxy:duckdb-owner-forward-failed', requestTemplate, {
      duckdbOwnerUrl: target.duckdbOwnerUrl,
      error: getDuckdbOwnerProxyErrorMessage(error),
      retryable: shouldRetryProxyRequest,
    })
    if (!shouldRetryProxyRequest) {
      return getImportArtifactFallbackForOwnerFailure(
        getDuckdbOwnerProxyFailureResponse(requestTemplate),
        importArtifactFallbackResponse,
      )
    }

    const retriedResponse = await getRetriedProxyResponse(requestTemplate, target.duckdbOwnerUrl)

    const ownerResponse =
      retriedResponse === null
        ? getDuckdbOwnerProxyFailureResponse(requestTemplate)
        : getDuckdbOwnerProxyResponse(retriedResponse)

    return getImportArtifactFallbackForOwnerFailure(ownerResponse, importArtifactFallbackResponse)
  }
}

export const forwardApiRequestToDuckdbOwner = async (request: Request): Promise<Response | null> => {
  if (!shouldCurrentServerProxyApiToOwner()) {
    return null
  }

  const streamingRequestTemplate = getDuckdbOwnerStreamingProxyRequestTemplate(request)

  return streamingRequestTemplate === null
    ? forwardBufferedApiRequestToDuckdbOwner(request)
    : forwardStreamingApiRequestToDuckdbOwner(streamingRequestTemplate)
}
