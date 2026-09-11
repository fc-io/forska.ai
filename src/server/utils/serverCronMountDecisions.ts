import {parseDuckdbMemoryLimitToMiB} from './duckdbMemoryLimit.ts'
import {
  type EffectiveServerRole,
  shouldServerRoleMountJudgingCrons,
  shouldServerRoleMountMaintenanceCrons,
} from './serverRole.ts'

export const lowMemoryMaintenanceDuckdbLimitMiB = 8192

export type ServerCronMountDecisions = {
  shouldMountOperationalJudgmentCrons: boolean
  shouldMountHeavyMaintenanceCrons: boolean
  shouldMountJudgingCrons: boolean
  shouldMountImportOnlyJudgmentCrons: boolean
  shouldDeferHeavyMaintenanceCronsForLowMemoryOwner: boolean
}

export const shouldDeferHeavyMaintenanceCronsForLowMemoryOwner = ({
  duckdbMemoryLimit,
  serverRole,
}: {
  duckdbMemoryLimit: string | null | undefined
  serverRole: EffectiveServerRole
}) => {
  const duckdbLimitMiB = parseDuckdbMemoryLimitToMiB(duckdbMemoryLimit)

  return (
    shouldServerRoleMountMaintenanceCrons(serverRole)
    && duckdbLimitMiB !== null
    && duckdbLimitMiB <= lowMemoryMaintenanceDuckdbLimitMiB
  )
}

export const getServerCronMountDecisions = ({
  duckdbMemoryLimit,
  serverRole,
  shouldRunMutatingServerWork,
}: {
  duckdbMemoryLimit: string | null | undefined
  serverRole: EffectiveServerRole
  shouldRunMutatingServerWork: boolean
}): ServerCronMountDecisions => {
  const shouldMountMaintenanceRoleCrons =
    shouldRunMutatingServerWork && shouldServerRoleMountMaintenanceCrons(serverRole)
  const shouldMountOperationalJudgmentCrons = shouldMountMaintenanceRoleCrons
  const shouldDeferHeavyMaintenanceCrons =
    shouldMountMaintenanceRoleCrons
    && shouldDeferHeavyMaintenanceCronsForLowMemoryOwner({duckdbMemoryLimit, serverRole})
  const shouldMountHeavyMaintenanceCrons = shouldMountMaintenanceRoleCrons && !shouldDeferHeavyMaintenanceCrons
  const shouldMountJudgingCrons = shouldRunMutatingServerWork && shouldServerRoleMountJudgingCrons(serverRole)
  const shouldMountImportOnlyJudgmentCrons = shouldMountJudgingCrons && !shouldMountOperationalJudgmentCrons

  return {
    shouldDeferHeavyMaintenanceCronsForLowMemoryOwner: shouldDeferHeavyMaintenanceCrons,
    shouldMountHeavyMaintenanceCrons,
    shouldMountImportOnlyJudgmentCrons,
    shouldMountJudgingCrons,
    shouldMountOperationalJudgmentCrons,
  }
}
