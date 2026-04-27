import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {hostname, networkInterfaces} from 'node:os'

export type LocalMachineLockMetadata = {hostname: string; machineFingerprint?: string}

export const normalizeMachineHostname = (value: string | null | undefined) => {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

const isNonEmptyString = (value: string | null | undefined): value is string => {
  return value !== null && value !== undefined && value !== ''
}

const getCommandOutput = (command: string, args: string[]) => {
  const result = spawnSync(command, args, {encoding: 'utf8'})

  if (result.error) {
    return null
  }

  const output = normalizeMachineHostname(result.stdout)

  return result.status === 0 && output !== '' ? output : null
}

const getDarwinLocalHostname = () => {
  return process.platform === 'darwin' ? getCommandOutput('/usr/sbin/scutil', ['--get', 'LocalHostName']) : null
}

const getDarwinPlatformUuid = () => {
  if (process.platform !== 'darwin') {
    return null
  }

  const result = spawnSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {encoding: 'utf8'})

  if (result.error) {
    return null
  }

  const platformUuid = /"IOPlatformUUID" = "([^"]+)"/.exec(String(result.stdout ?? ''))?.[1]

  return result.status === 0 && platformUuid !== undefined ? normalizeMachineHostname(platformUuid) : null
}

const getShellHostname = () => {
  return getCommandOutput('hostname', [])
}

const getCurrentHostnameAliases = () => {
  const currentHostname = normalizeMachineHostname(hostname())
  const darwinLocalHostname = getDarwinLocalHostname()
  const shellHostname = getShellHostname()
  const aliases = [
    currentHostname,
    currentHostname.split('.')[0],
    shellHostname,
    shellHostname === null ? null : shellHostname.split('.')[0],
    darwinLocalHostname,
    darwinLocalHostname === null ? null : `${darwinLocalHostname}.local`,
  ].filter(isNonEmptyString)

  return Array.from(new Set(aliases))
}

const getCurrentMachineFingerprintSource = () => {
  const darwinPlatformUuid = getDarwinPlatformUuid()

  if (darwinPlatformUuid !== null) {
    return darwinPlatformUuid
  }

  const macAddresses = Array.from(
    new Set(
      Object.values(networkInterfaces())
        .flatMap((addresses) => {
          return (addresses ?? []).map((address) => {
            return address.mac.trim().toLowerCase()
          })
        })
        .filter((macAddress) => {
          return macAddress !== '' && macAddress !== '00:00:00:00:00:00'
        }),
    ),
  ).sort()

  return macAddresses.length > 0 ? macAddresses.join('|') : normalizeMachineHostname(hostname())
}

const currentMachineFingerprint = createHash('sha256').update(getCurrentMachineFingerprintSource()).digest('hex')
const currentHostnameAliases = getCurrentHostnameAliases()

export const getLocalMachineFingerprint = () => {
  return currentMachineFingerprint
}

export const isLockOwnedByCurrentMachine = (metadata: LocalMachineLockMetadata) => {
  const matchesCurrentHostname = currentHostnameAliases.includes(normalizeMachineHostname(metadata.hostname))

  return matchesCurrentHostname || metadata.machineFingerprint === currentMachineFingerprint
}
