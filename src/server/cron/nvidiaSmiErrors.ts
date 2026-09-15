const expectedUnavailableFragments = [
  'Executable not found',
  'command not found',
  'Connection refused',
  'Connection timed out',
  'Connection closed by',
]

export const isExpectedNvidiaSmiTelemetryUnavailable = (stderr: string): boolean => {
  return expectedUnavailableFragments.some((fragment) => {
    return stderr.includes(fragment)
  })
}
