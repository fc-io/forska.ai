export const serverRoles = ['auto', 'writer', 'api', 'worker', 'dev-single'] as const

export type ServerRole = (typeof serverRoles)[number]
export type EffectiveServerRole = Exclude<ServerRole, 'auto'>

export const getEffectiveServerRole = (serverRole: ServerRole): EffectiveServerRole => {
  return serverRole === 'auto' ? 'api' : serverRole
}

export const isAutoServerRole = (serverRole: ServerRole) => {
  return serverRole === 'auto'
}

export const canServerRoleOwnDuckdb = (serverRole: ServerRole) => {
  return serverRole === 'writer' || serverRole === 'dev-single'
}

export const shouldServerRoleMountWriterCrons = (serverRole: ServerRole) => {
  return serverRole === 'auto' || canServerRoleOwnDuckdb(serverRole)
}

export const shouldServerRoleProxyApiToWriter = (serverRole: ServerRole) => {
  return serverRole === 'api'
}
