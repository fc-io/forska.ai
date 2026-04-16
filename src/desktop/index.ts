import {BrowserWindow} from 'electrobun/bun'

import {getDesktopRuntimeConfig} from './getDesktopRuntimeConfig.ts'

const backendReadyPollIntervalMs = 250
const backendReadyTimeoutMs = 30_000

const getStartupErrorUrl = ({details, message}: {details: string; message: string}) => {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Forska Startup Error</title><style>body{background:#f5f1e8;color:#1f2937;font-family:Georgia,serif;margin:0}main{margin:0 auto;max-width:720px;padding:56px 28px}h1{font-size:32px;margin:0 0 16px}p{font-size:16px;line-height:1.6;margin:0 0 12px}pre{background:#fff;border:1px solid #d6d3d1;border-radius:12px;overflow:auto;padding:16px;white-space:pre-wrap}</style></head><body><main><h1>Forska desktop startup failed</h1><p>${message}</p><pre>${details}</pre></main></body></html>`)}`
}

const sleep = (ms: number) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const waitForBackendReady = async ({apiOrigin, deadlineMs}: {apiOrigin: string; deadlineMs: number}): Promise<void> => {
  const response = await fetch(`${apiOrigin}/api/writer_connections`, {method: 'GET'}).catch(() => {
    return null
  })

  if (response?.ok) {
    return
  }

  if (Date.now() >= deadlineMs) {
    throw new Error(`Desktop backend did not become ready within ${String(backendReadyTimeoutMs / 1000)} seconds.`)
  }

  await sleep(backendReadyPollIntervalMs)
  return waitForBackendReady({apiOrigin, deadlineMs})
}

const createWindow = ({title, url}: {title: string; url: string}) => {
  return new BrowserWindow({frame: {height: 980, width: 1440, x: 120, y: 80}, title, url})
}

const runtimeConfig = getDesktopRuntimeConfig()
const getBackendProcessResult = () => {
  try {
    return {
      error: null,
      process: globalThis.Bun.spawn(runtimeConfig.backendCommand, {
        cwd: runtimeConfig.dataRoot,
        env: runtimeConfig.backendEnv,
        stderr: 'inherit',
        stdout: 'inherit',
      }),
    } as const
  } catch (error) {
    return {error, process: null} as const
  }
}

const backendProcessResult = getBackendProcessResult()

const stopBackend = () => {
  backendProcessResult.process?.kill()
}

process.on('exit', stopBackend)
;(['SIGHUP', 'SIGINT', 'SIGTERM'] as const).map((signal) => {
  return process.on(signal, () => {
    stopBackend()
    process.exit(0)
  })
})

await (
  backendProcessResult.error === null
    ? waitForBackendReady({apiOrigin: runtimeConfig.apiOrigin, deadlineMs: Date.now() + backendReadyTimeoutMs})
    : Promise.reject(backendProcessResult.error)
)
  .then(() => {
    createWindow({title: 'Forska', url: runtimeConfig.windowUrl})
  })
  .catch((error) => {
    const errorMessage = error instanceof Error ? error.message : String(error)

    createWindow({
      title: 'Forska Startup Error',
      url: getStartupErrorUrl({
        details: `apiOrigin=${runtimeConfig.apiOrigin}\ndataRoot=${runtimeConfig.dataRoot}\ncommand=${runtimeConfig.backendCommand.join(' ')}`,
        message: errorMessage,
      }),
    })
  })
