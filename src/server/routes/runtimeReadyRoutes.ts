import {Elysia} from 'elysia'

import {getRuntimeCutoverVersion} from '../utils/runtimeCutover.ts'
import {runtimeReadyPath} from '../utils/runtimeReadyContract.ts'
import {getServerRoleCapabilities} from '../utils/serverRole.ts'
import {
  canCurrentServerOwnDuckdb,
  getCurrentServerRole,
  getKnownDuckdbOwnerUrl,
  shouldCurrentServerProxyApiToOwner,
} from '../utils/serverRuntimeRole.ts'

export const runtimeReadyRoutes = new Elysia().get(runtimeReadyPath, () => {
  const role = getCurrentServerRole()

  return {
    data: {
      capabilities: getServerRoleCapabilities(role),
      duckdbOwner: canCurrentServerOwnDuckdb(),
      duckdbOwnerUrl: getKnownDuckdbOwnerUrl(),
      ownerProxy: shouldCurrentServerProxyApiToOwner(),
      ready: true,
      role,
      runtimeVersion: getRuntimeCutoverVersion(),
    },
    error: null,
  }
})
