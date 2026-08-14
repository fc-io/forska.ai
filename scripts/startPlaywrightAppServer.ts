const parentPid = process.ppid

const isParentProcessAlive = () => {
  try {
    process.kill(parentPid, 0)
    return true
  } catch {
    return false
  }
}

const parentMonitor = setInterval(() => {
  if (process.ppid !== parentPid || !isParentProcessAlive()) {
    process.exit(0)
  }
}, 250)

parentMonitor.unref()
process.once('exit', () => {
  clearInterval(parentMonitor)
})

await import('../src/appServer.ts')
