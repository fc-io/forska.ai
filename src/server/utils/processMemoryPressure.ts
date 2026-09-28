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

// The process's own memory figure: the physical footprint on macOS, RSS elsewhere.
export const getProcessMemoryBytes = (rssBytes: number = process.memoryUsage().rss) => {
  const sample = getProcessMemoryUsageSample()

  if (sample === null) {
    return rssBytes
  }

  const tolerance = Math.max(residentAgreementToleranceBytes, sample.residentBytes * residentAgreementToleranceRatio)

  return Math.abs(rssBytes - sample.residentBytes) <= tolerance ? sample.physFootprintBytes : rssBytes
}

// The memory budget of a DuckDB owner is DuckDB's whole allowance, which DuckDB enforces itself, plus headroom for the
// rest of the process. A cap is judged by the app's own memory (the process figure minus what DuckDB reports holding)
// against the headroom next to that allowance, so DuckDB at its ceiling is normal and never throttles or recycles by
// itself, while the app cannot grow into memory DuckDB is entitled to. Caps set below the allowance (low-memory
// runtimes), or processes without a recent DuckDB sample, compare the whole process figure against the cap.
const duckdbMemorySampleMaxAgeMs = 2 * 60_000

type DuckdbMemorySample = {limitBytes: number; sampledAtMs: number; trackedBytes: number}

let duckdbMemorySample: DuckdbMemorySample | null = null

export const recordDuckdbMemoryUsage = (input: {limitBytes: number | null; nowMs?: number; trackedBytes: number}) => {
  duckdbMemorySample =
    input.limitBytes !== null && input.limitBytes > 0 && Number.isFinite(input.trackedBytes) && input.trackedBytes >= 0
      ? {limitBytes: input.limitBytes, sampledAtMs: input.nowMs ?? Date.now(), trackedBytes: input.trackedBytes}
      : null
}

// After DuckDB is closed its memory is released, so a sample taken before would hide the app's real share.
export const markDuckdbMemoryReleased = (nowMs: number = Date.now()) => {
  if (duckdbMemorySample !== null) {
    duckdbMemorySample = {...duckdbMemorySample, sampledAtMs: nowMs, trackedBytes: 0}
  }
}

export const getDuckdbMemoryUsageSampleAgeMs = (nowMs: number = Date.now()) => {
  return duckdbMemorySample === null ? null : nowMs - duckdbMemorySample.sampledAtMs
}

export type ProcessMemoryBudgetUsage = {
  appBytes: number | null
  duckdbLimitBytes: number | null
  duckdbTrackedBytes: number | null
  processBytes: number
}

export const getProcessMemoryBudgetUsage = (
  rssBytes: number = process.memoryUsage().rss,
  nowMs: number = Date.now(),
): ProcessMemoryBudgetUsage => {
  const processBytes = getProcessMemoryBytes(rssBytes)
  const sample =
    duckdbMemorySample !== null && nowMs - duckdbMemorySample.sampledAtMs <= duckdbMemorySampleMaxAgeMs
      ? duckdbMemorySample
      : null

  return sample === null
    ? {appBytes: null, duckdbLimitBytes: null, duckdbTrackedBytes: null, processBytes}
    : {
        appBytes: Math.max(0, processBytes - Math.min(sample.trackedBytes, sample.limitBytes)),
        duckdbLimitBytes: sample.limitBytes,
        duckdbTrackedBytes: sample.trackedBytes,
        processBytes,
      }
}

// A single figure on the cap's scale: the app's memory plus DuckDB's whole allowance under the budget model, the
// process figure otherwise. Differences between two readings track the app's own growth.
export const getProcessMemoryPressureBytes = (usage: ProcessMemoryBudgetUsage = getProcessMemoryBudgetUsage()) => {
  return usage.appBytes === null || usage.duckdbLimitBytes === null
    ? usage.processBytes
    : usage.appBytes + usage.duckdbLimitBytes
}

// Whether memory is at `fraction` of the cap: of the headroom above DuckDB's allowance under the budget model.
export const isProcessMemoryAtCap = (
  capBytes: number,
  fraction = 1,
  usage: ProcessMemoryBudgetUsage = getProcessMemoryBudgetUsage(),
) => {
  if (!(capBytes > 0)) {
    return false
  }

  if (usage.appBytes !== null && usage.duckdbLimitBytes !== null && capBytes > usage.duckdbLimitBytes) {
    return usage.appBytes >= fraction * (capBytes - usage.duckdbLimitBytes)
  }

  return usage.processBytes >= fraction * capBytes
}

export const resetDuckdbMemoryUsageForTests = () => {
  duckdbMemorySample = null
}
