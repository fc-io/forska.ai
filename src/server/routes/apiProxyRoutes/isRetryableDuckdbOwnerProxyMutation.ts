import type {DuckdbOwnerProxyRequestTemplate} from './duckdbOwnerProxyRequestTemplate.ts'
import {getPublicDuckdbOwnerProxyPathname} from './getPublicDuckdbOwnerProxyPathname.ts'

export const isRetryableDuckdbOwnerProxyMutation = (requestTemplate: DuckdbOwnerProxyRequestTemplate) => {
  if (requestTemplate.method !== 'POST') {
    return false
  }

  return (
    getPublicDuckdbOwnerProxyPathname(requestTemplate).match(
      /^\/api\/comparison-projects\/[^/]+\/conflict-resolution(?:\/reset)?$/,
    ) !== null
  )
}
