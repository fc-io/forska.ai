import {
  getDuckdbGracefulShutdownBudgetMs,
  getDuckdbGracefulShutdownTimeouts,
} from '../src/server/utils/duckdbGracefulShutdown.ts'

export type ServerStackManagedRole = 'api' | 'judge' | 'maintenance'

export type ServerStackShutdownTimeouts = {
  forcedKillTimeoutMs: number
  maintenanceShutdownTimeoutMs: number
  workerShutdownTimeoutMs: number
}

export const serverStackShutdownDefaultTimeouts: ServerStackShutdownTimeouts = {
  forcedKillTimeoutMs: 5_000,
  maintenanceShutdownTimeoutMs: 240_000,
  workerShutdownTimeoutMs: 20_000,
}

const duckdbOwnerForceExitMarginMs = 30_000
const maintenanceShutdownMarginMs = 10_000
const devServerWatchStackShutdownMarginMs = 30_000

const getPositiveIntegerEnvValue = (value: string | undefined) => {
  const parsedValue = Number(String(value ?? '').trim())

  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : null
}

const getDefaultMaintenanceShutdownTimeoutMs = (envValues: Record<string, string | undefined>) => {
  const duckdbOwnerShutdownMs =
    getDuckdbGracefulShutdownBudgetMs(getDuckdbGracefulShutdownTimeouts(envValues))
    + duckdbOwnerForceExitMarginMs
    + maintenanceShutdownMarginMs

  return Math.max(serverStackShutdownDefaultTimeouts.maintenanceShutdownTimeoutMs, duckdbOwnerShutdownMs)
}

export const getServerStackShutdownTimeouts = (
  envValues: Record<string, string | undefined> = process.env,
): ServerStackShutdownTimeouts => {
  return {
    ...serverStackShutdownDefaultTimeouts,
    maintenanceShutdownTimeoutMs:
      getPositiveIntegerEnvValue(envValues.FORSKA_SERVER_STACK_MAINTENANCE_SHUTDOWN_TIMEOUT_MS)
      ?? getDefaultMaintenanceShutdownTimeoutMs(envValues),
  }
}

export const getServerStackRoleShutdownTimeoutMs = (
  role: ServerStackManagedRole,
  timeouts: ServerStackShutdownTimeouts,
) => {
  return role === 'maintenance' ? timeouts.maintenanceShutdownTimeoutMs : timeouts.workerShutdownTimeoutMs
}

export const getServerStackShutdownBudgetMs = (timeouts: ServerStackShutdownTimeouts) => {
  return (
    timeouts.workerShutdownTimeoutMs
    + timeouts.forcedKillTimeoutMs
    + timeouts.maintenanceShutdownTimeoutMs
    + timeouts.forcedKillTimeoutMs
  )
}

export const getDevServerWatchStackShutdownTimeoutMs = (
  envValues: Record<string, string | undefined> = process.env,
) => {
  return getServerStackShutdownBudgetMs(getServerStackShutdownTimeouts(envValues)) + devServerWatchStackShutdownMarginMs
}

export const stopServerStackRolesInOrder = async (stopRole: (role: ServerStackManagedRole) => Promise<void>) => {
  const workerResults = await Promise.allSettled([stopRole('api'), stopRole('judge')])
  const maintenanceResults = await Promise.allSettled([stopRole('maintenance')])

  return [...workerResults, ...maintenanceResults].flatMap((result) => {
    return result.status === 'rejected' ? [result.reason as unknown] : []
  })
}
