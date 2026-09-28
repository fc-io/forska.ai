import {dlopen, FFIType, ptr} from 'bun:ffi'

// On macOS, RSS keeps counting pages the allocator has already freed (MADV_FREE_REUSABLE) until the kernel reclaims
// them. The live maintenance worker showed 17.0 GB RSS against an 8.5 GB physical footprint, with 8.6 GB of that RSS
// reclaimable, so RSS-based caps throttled rebuild batching and dirty-work wakes while half the "usage" was free
// memory. The physical footprint is what macOS charges the process for and what memory pressure acts on.

type ProcPidRusage = (pid: number, flavor: number, buffer: ReturnType<typeof ptr>) => number

// rusage_info_v0: 16-byte uuid, then uint64 user_time, system_time, pkg_idle_wkups, interrupt_wkups, pageins,
// wired_size, resident_size, phys_footprint, ...
const rusageInfoV0Flavor = 0
const rusageInfoResidentSizeIndex = 8
const rusageInfoPhysFootprintIndex = 9
const rusageInfoBufferWords = 32
// Footprint only stands in for an RSS reading it agrees with on resident size; anything else (another sampling
// source, a replaced process.memoryUsage) keeps the RSS reading as it is.
const residentAgreementToleranceBytes = 4 * 1024 ** 2
const residentAgreementToleranceRatio = 0.02

let procPidRusage: ProcPidRusage | null | undefined

const getProcPidRusage = () => {
  if (procPidRusage !== undefined) {
    return procPidRusage
  }

  procPidRusage = null

  if (process.platform !== 'darwin') {
    return procPidRusage
  }

  try {
    const library = dlopen('/usr/lib/libSystem.B.dylib', {
      proc_pid_rusage: {args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32},
    })

    procPidRusage = library.symbols.proc_pid_rusage as ProcPidRusage
  } catch {
    procPidRusage = null
  }

  return procPidRusage
}

export const getProcessMemoryUsageSample = () => {
  const reader = getProcPidRusage()

  if (reader === null) {
    return null
  }

  const buffer = new BigUint64Array(rusageInfoBufferWords)

  try {
    if (reader(process.pid, rusageInfoV0Flavor, ptr(buffer)) !== 0) {
      return null
    }
  } catch {
    return null
  }

  const residentBytes = Number(buffer[rusageInfoResidentSizeIndex])
  const physFootprintBytes = Number(buffer[rusageInfoPhysFootprintIndex])

  return residentBytes > 0 && physFootprintBytes > 0 ? {physFootprintBytes, residentBytes} : null
}

// The memory figure caps should compare against: the physical footprint on macOS, RSS elsewhere.
export const getProcessMemoryPressureBytes = (rssBytes: number = process.memoryUsage().rss) => {
  const sample = getProcessMemoryUsageSample()

  if (sample === null) {
    return rssBytes
  }

  const tolerance = Math.max(residentAgreementToleranceBytes, sample.residentBytes * residentAgreementToleranceRatio)

  return Math.abs(rssBytes - sample.residentBytes) <= tolerance ? sample.physFootprintBytes : rssBytes
}
