export const serverRoles = ['writer', 'api', 'worker', 'dev-single'] as const

export type ServerRole = (typeof serverRoles)[number]

export const canServerRoleOwnDuckdb = (serverRole: ServerRole) => {
  return serverRole === 'writer' || serverRole === 'dev-single'
}

export const shouldServerRoleMountWriterCrons = (serverRole: ServerRole) => {
  return canServerRoleOwnDuckdb(serverRole)
}

export const shouldServerRoleProxyApiToWriter = (serverRole: ServerRole) => {
  return serverRole === 'api'
}
