import {
  shouldCurrentServerMountDuckdbOwnerPrivateApi,
  shouldCurrentServerMountPublicProductApi,
  shouldCurrentServerProxyApiToOwner,
  shouldCurrentServerRunJudgingLoops,
} from '../../../utils/serverRuntimeRole.ts'
import {duckdbOwnerPrivateApiPrefix} from '../../apiRouteClassification.ts'

export const getRouteServingMode = () => {
  const publicProductApi = shouldCurrentServerMountPublicProductApi()
  const duckdbOwnerPrivateApi = shouldCurrentServerMountDuckdbOwnerPrivateApi()
  const ownerProxy = shouldCurrentServerProxyApiToOwner()
  const judgingRuntime = shouldCurrentServerRunJudgingLoops()
  const mode =
    publicProductApi && duckdbOwnerPrivateApi
      ? 'public-and-duckdb-owner-private'
      : publicProductApi && ownerProxy
        ? 'public-api-with-owner-proxy'
        : duckdbOwnerPrivateApi
          ? 'duckdb-owner-private-api'
          : judgingRuntime
            ? 'judging-runtime'
            : 'diagnostics-only'

  return {duckdbOwnerPrivateApi, duckdbOwnerPrivateApiPrefix, judgingRuntime, mode, ownerProxy, publicProductApi}
}
