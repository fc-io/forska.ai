const mebibyte = 1024 ** 2

const duckdbMemoryLimitUnitToBytes = {
  gb: 1000 ** 3,
  gib: 1024 ** 3,
  kb: 1000,
  kib: 1024,
  mb: 1000 ** 2,
  mib: mebibyte,
  tb: 1000 ** 4,
  tib: 1024 ** 4,
} as const

export const parseDuckdbMemoryLimitToMiB = (value: string | null | undefined) => {
  const normalized = String(value ?? '').trim()
  const match = /^(\d+(?:\.\d+)?)\s*(gb|gib|kb|kib|mb|mib|tb|tib)$/i.exec(normalized)

  if (!match) {
    return null
  }

  const amount = Number(match[1])
  const unit = match[2]?.toLowerCase() as keyof typeof duckdbMemoryLimitUnitToBytes | undefined
  const unitBytes = unit === undefined ? null : duckdbMemoryLimitUnitToBytes[unit]

  if (!Number.isFinite(amount) || unitBytes === null) {
    return null
  }

  return Math.floor((amount * unitBytes) / mebibyte)
}
