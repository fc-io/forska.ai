import {existsSync, watch} from 'node:fs'

import {spawn, type Subprocess} from 'bun'

const watchedPaths = ['src', 'package.json', 'tsconfig.json']
const restartDelayMs = 150

type ServerProcess = Subprocess<'inherit', 'inherit', 'inherit'>

let restartTimer: ReturnType<typeof setTimeout> | null = null
let serverProcess: ServerProcess | null = null
let shuttingDown = false

const log = (message: string) => {
  console.log(`[dev:server] ${message}`)
}

const getServerEnv = () => {
  return {...process.env, BUN_CONFIG_MAX_HTTP_REQUESTS: process.env.BUN_CONFIG_MAX_HTTP_REQUESTS ?? '2048'}
}

const startServer = () => {
  serverProcess = spawn(['bun', 'run', 'src/server/index.ts'], {
    cwd: process.cwd(),
    env: getServerEnv(),
    stderr: 'inherit',
    stdin: 'inherit',
    stdout: 'inherit',
  })
}

const stopServer = async () => {
  if (!serverProcess) {
    return
  }

  const processToStop = serverProcess
  serverProcess = null
  processToStop.kill()
  await processToStop.exited
}

const restartServer = () => {
  if (shuttingDown) {
    return
  }

  if (restartTimer) {
    clearTimeout(restartTimer)
  }

  restartTimer = setTimeout(() => {
    void (async () => {
      restartTimer = null
      log('change detected, restarting')
      await stopServer()
      startServer()
    })()
  }, restartDelayMs)
}

const createWatcher = (watchedPath: string) => {
  if (!existsSync(watchedPath)) {
    return
  }

  watch(watchedPath, {recursive: true}, () => {
    restartServer()
  })
}

const shutdown = async () => {
  if (shuttingDown) {
    return
  }

  shuttingDown = true

  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }

  await stopServer()
  process.exit(0)
}

process.on('SIGINT', () => {
  void shutdown()
})

process.on('SIGTERM', () => {
  void shutdown()
})

watchedPaths.forEach((watchedPath) => {
  createWatcher(watchedPath)
})

startServer()
