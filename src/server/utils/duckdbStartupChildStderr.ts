const bunCrashMarkers = ['panic(', 'Bun has crashed']
const bunCrashContextMaxLength = 2_000

const isBunCrashBannerLine = (line: string) => {
  const trimmedLine = line.trim()

  return (
    /^={20,}$/u.test(trimmedLine)
    || /^Bun v\d/u.test(trimmedLine)
    || /^panic[(:]/u.test(trimmedLine)
    || trimmedLine.includes('Bun has crashed')
  )
}

const getBunCrashContext = (lines: string[]) => {
  const bannerIndex = lines.findIndex(isBunCrashBannerLine)
  const context = lines
    .slice(0, bannerIndex === -1 ? 0 : bannerIndex)
    .join('\n')
    .trim()

  return context.length > bunCrashContextMaxLength ? `...${context.slice(-bunCrashContextMaxLength)}` : context
}

const getBunCrashPanicLine = (lines: string[]) => {
  return (
    lines
      .map((line) => {
        return line.trim()
      })
      .find((line) => {
        return /^panic[(:]/u.test(line)
      })
    ?? lines
      .map((line) => {
        return line.trim()
      })
      .find((line) => {
        return line.includes('Bun has crashed')
      })
    ?? 'Bun crashed'
  )
}

const getBunCrashReportUrl = (stderr: string) => {
  return /https:\/\/bun\.report\/\S+/u.exec(stderr)?.[0] ?? null
}

export const isBunCrashOutput = (stderr: string) => {
  return bunCrashMarkers.some((marker) => {
    return stderr.includes(marker)
  })
}

export const summarizeDuckdbStartupChildStderr = (stderr: string) => {
  if (!isBunCrashOutput(stderr)) {
    return stderr
  }

  const lines = stderr.split(/\r?\n/u)
  const reportUrl = getBunCrashReportUrl(stderr)

  return [
    getBunCrashContext(lines),
    `Bun crashed: ${getBunCrashPanicLine(lines)}`,
    reportUrl === null ? '' : `crash report: ${reportUrl}`,
  ]
    .filter((part) => {
      return part !== ''
    })
    .join(' -- ')
}
