import {totalmem} from 'node:os'

const mebibyte = 1024 ** 2
const darwinMaximumMaintenanceDuckdbMemoryLimitMiB = 6400
const defaultMaximumMaintenanceDuckdbMemoryLimitMiB = 20 * 1024
const minimumMaintenanceDuckdbMemoryLimitMiB = 4 * 1024

export const getDefaultMaintenanceDuckdbMemoryLimit = (totalMemoryBytes = totalmem(), platform = process.platform) => {
  const totalMemoryMiB = Math.floor(totalMemoryBytes / mebibyte)
  const derivedLimitMiB = Math.floor(totalMemoryMiB / 2)
  const maximumMaintenanceDuckdbMemoryLimitMiB =
    platform === 'darwin' ? darwinMaximumMaintenanceDuckdbMemoryLimitMiB : defaultMaximumMaintenanceDuckdbMemoryLimitMiB
  const maintenanceDuckdbMemoryLimitMiB = Math.max(
    minimumMaintenanceDuckdbMemoryLimitMiB,
    Math.min(maximumMaintenanceDuckdbMemoryLimitMiB, derivedLimitMiB),
  )

  return maintenanceDuckdbMemoryLimitMiB % 1024 === 0
    ? `${maintenanceDuckdbMemoryLimitMiB / 1024}GB`
    : `${maintenanceDuckdbMemoryLimitMiB}MiB`
}
