export const serverRoles = ['auto', 'writer', 'api', 'worker', 'dev-single'] as const

export type ServerRole = (typeof serverRoles)[number]
export type EffectiveServerRole = Exclude<ServerRole, 'auto'>
export type ServerRoleCapability = 'api' | 'duckdb-owner' | 'judging' | 'maintenance'

export const getEffectiveServerRole = (serverRole: ServerRole): EffectiveServerRole => {
  return serverRole === 'auto' ? 'api' : serverRole
}

export const isAutoServerRole = (serverRole: ServerRole) => {
  return serverRole === 'auto'
}

export const canServerRoleOwnDuckdb = (serverRole: ServerRole) => {
  return serverRole === 'writer' || serverRole === 'worker' || serverRole === 'dev-single'
}

export const shouldServerRoleMountWriterCrons = (serverRole: ServerRole) => {
  return serverRole === 'auto' || canServerRoleOwnDuckdb(serverRole)
}

export const shouldServerRoleProxyApiToWriter = (serverRole: ServerRole) => {
  return serverRole === 'api'
}

export const getServerRoleCapabilities = (serverRole: ServerRole): ServerRoleCapability[] => {
  return serverRole === 'api'
    ? ['api']
    : serverRole === 'dev-single' || serverRole === 'auto'
      ? ['api', 'duckdb-owner', 'maintenance', 'judging']
      : canServerRoleOwnDuckdb(serverRole)
        ? ['duckdb-owner', 'maintenance', 'judging']
        : []
}
