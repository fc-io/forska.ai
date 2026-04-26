export const productionServerRoles = ['api', 'maintenance-worker', 'judge-worker'] as const
export const localServerRoles = ['auto', 'dev-single'] as const
export const serverRoles = [...productionServerRoles, ...localServerRoles] as const

export type ServerRole = (typeof serverRoles)[number]
export type EffectiveServerRole = Exclude<ServerRole, 'auto'>
export type ServerRoleCapability = 'api' | 'duckdb-owner' | 'judging' | 'maintenance' | 'owner-proxy'

const serverRoleCapabilities = {
  api: ['api', 'owner-proxy'],
  auto: ['api', 'owner-proxy'],
  'dev-single': ['api', 'duckdb-owner', 'maintenance', 'judging'],
  'judge-worker': ['judging'],
  'maintenance-worker': ['duckdb-owner', 'maintenance'],
} satisfies Record<ServerRole, ServerRoleCapability[]>

export const getEffectiveServerRole = (serverRole: ServerRole): EffectiveServerRole => {
  return serverRole === 'auto' ? 'api' : serverRole
}

export const isAutoServerRole = (serverRole: ServerRole) => {
  return serverRole === 'auto'
}

export const canServerRoleOwnDuckdb = (serverRole: ServerRole) => {
  return getServerRoleCapabilities(serverRole).includes('duckdb-owner')
}

export const canServerRoleRunMaintenanceLoops = (serverRole: ServerRole) => {
  return getServerRoleCapabilities(serverRole).includes('maintenance')
}

export const shouldServerRoleRunMaintenanceLoops = canServerRoleRunMaintenanceLoops

export const shouldServerRoleRunMaintenanceWork = canServerRoleRunMaintenanceLoops

export const canServerRoleRunJudgingLoops = (serverRole: ServerRole) => {
  return getServerRoleCapabilities(serverRole).includes('judging')
}

export const shouldServerRoleRunJudgingLoops = canServerRoleRunJudgingLoops

export const shouldServerRoleRunJudgingWork = canServerRoleRunJudgingLoops

export const canServerRoleProxyApiToOwner = (serverRole: ServerRole) => {
  return getServerRoleCapabilities(serverRole).includes('owner-proxy')
}

export const shouldServerRoleProxyApiToOwner = canServerRoleProxyApiToOwner

export const shouldServerRoleProxyApiToDuckdbOwner = canServerRoleProxyApiToOwner

export const shouldServerRoleMountPublicProductApi = (serverRole: ServerRole) => {
  return getServerRoleCapabilities(serverRole).includes('api')
}

export const shouldServerRoleMountDuckdbOwnerPrivateApi = (serverRole: ServerRole) => {
  return canServerRoleOwnDuckdb(serverRole)
}

export const getServerRoleCapabilities = (serverRole: ServerRole): ServerRoleCapability[] => {
  return [...serverRoleCapabilities[serverRole]]
}

export const shouldServerRoleMountRuntimeCrons = (serverRole: ServerRole) => {
  return shouldServerRoleMountMaintenanceCrons(serverRole) || shouldServerRoleMountJudgingCrons(serverRole)
}

export const shouldServerRoleMountMaintenanceCrons = (serverRole: ServerRole) => {
  return serverRole === 'maintenance-worker' || serverRole === 'dev-single'
}

export const shouldServerRoleMountJudgingCrons = (serverRole: ServerRole) => {
  return shouldServerRoleRunJudgingLoops(serverRole)
}

export const shouldServerRoleRunCodexStartup = (serverRole: ServerRole) => {
  return serverRole === 'api' || serverRole === 'dev-single'
}
