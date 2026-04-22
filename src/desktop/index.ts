import {appendFileSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {BrowserWindow} from 'electrobun/bun'

import {acquireDesktopSingleInstance} from './desktopSingleInstance.ts'
import {getDesktopRuntimeConfig} from './getDesktopRuntimeConfig.ts'

const backendReadyPollIntervalMs = 250
const backendReadyTimeoutMs = 30_000
const backendLogTailMaxChars = 12_000
const defaultWindowFrame = {height: 980, width: 1440, x: 120, y: 80}
const startupWindowFrame = {height: 540, width: 760, x: 420, y: 140}

const getStartupErrorUrl = ({details, message}: {details: string; message: string}) => {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Forska Startup Error</title><style>body{background:#f5f1e8;color:#1f2937;font-family:Georgia,serif;margin:0}main{margin:0 auto;max-width:720px;padding:56px 28px}h1{font-size:32px;margin:0 0 16px}p{font-size:16px;line-height:1.6;margin:0 0 12px}pre{background:#fff;border:1px solid #d6d3d1;border-radius:12px;overflow:auto;padding:16px;white-space:pre-wrap}</style></head><body><main><h1>Forska desktop startup failed</h1><p>${message}</p><pre>${details}</pre></main></body></html>`)}`
}

const getStartupSplashUrl = () => {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Forska Starting</title><style>body{align-items:center;background:radial-gradient(circle at top,#f3f4f6 0%,#e7ecf5 42%,#d8e0ef 100%);color:#111827;display:flex;font-family:Inter,ui-sans-serif,system-ui,sans-serif;justify-content:center;margin:0;min-height:100vh}main{background:rgba(255,255,255,0.92);border:1px solid rgba(148,163,184,0.28);border-radius:28px;box-shadow:0 28px 90px rgba(15,23,42,0.12);max-width:560px;padding:40px 36px;width:calc(100vw - 48px)}.eyebrow{color:#335c95;font-size:12px;font-weight:700;letter-spacing:.28em;text-transform:uppercase}.row{align-items:center;display:flex;gap:18px;margin-top:18px}.mark{align-items:center;background:#234a7a;border-radius:18px;color:#fff;display:flex;font-family:ui-monospace,SFMono-Regular,monospace;font-size:28px;font-weight:700;height:64px;justify-content:center;letter-spacing:.04em;width:64px}.title{font-size:32px;font-weight:700;letter-spacing:-.03em;line-height:1.1;margin:0}.copy{color:#475569;font-size:15px;line-height:1.7;margin:14px 0 0}.meta{border-top:1px solid rgba(148,163,184,0.24);color:#64748b;font-size:12px;letter-spacing:.08em;margin-top:28px;padding-top:18px;text-transform:uppercase}</style></head><body><main><div class="eyebrow">Desktop startup</div><div class="row"><div class="mark">F</div><div><h1 class="title">Starting Forska</h1><p class="copy">Opening the local desktop workspace, warming the API, and checking database migrations before the main app appears.</p></div></div><div class="meta">Keep this window open while Forska connects to its local backend.</div></main></body></html>`)}`
}

const sleep = (ms: number) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const waitForBackendReady = async ({apiOrigin, deadlineMs}: {apiOrigin: string; deadlineMs: number}): Promise<void> => {
  const response = await fetch(`${apiOrigin}/api/runtime/ready`, {method: 'GET'}).catch(() => {
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

const createWindow = ({
  frame = defaultWindowFrame,
  preload,
  title,
  url,
  viewsRoot,
}: {
  frame?: {height: number; width: number; x: number; y: number}
  preload: string
  title: string
  url: string
  viewsRoot: string
}) => {
  return new BrowserWindow({frame, preload, title, url, viewsRoot})
}

const runtimeConfig = getDesktopRuntimeConfig()
const desktopSingleInstanceLockPath = resolve(runtimeConfig.dataRoot, 'desktop.lock.json')
const desktopSingleInstanceResult = acquireDesktopSingleInstance({lockPath: desktopSingleInstanceLockPath})
let backendLogTail = ''

const getDesktopApiRequestUrl = ({path}: {path: string}) => {
  if (!path.startsWith('/api/')) {
    throw new Error(`Desktop API bridge only supports /api routes, received ${path}`)
  }

  return `${runtimeConfig.apiOrigin}${path}`
}

const appendBackendLog = ({text, writeToStderr = false}: {text: string; writeToStderr?: boolean}) => {
  if (text === '') {
    return
  }

  appendFileSync(runtimeConfig.backendLogPath, text, 'utf8')
  backendLogTail = `${backendLogTail}${text}`.slice(-backendLogTailMaxChars)
  return writeToStderr ? process.stderr.write(text) : process.stdout.write(text)
}

const readBackendStream = async ({
  decoder,
  onText,
  reader,
}: {
  decoder: TextDecoder
  onText: (text: string) => void
  reader: ReadableStreamDefaultReader<Uint8Array>
}): Promise<void> => {
  const {done, value} = await reader.read()

  if (done) {
    const trailingText = decoder.decode()

    if (trailingText !== '') {
      onText(trailingText)
    }

    return
  }

  const text = decoder.decode(value, {stream: true})

  if (text !== '') {
    onText(text)
  }

  return readBackendStream({decoder, onText, reader})
}

const consumeBackendStream = ({
  onText,
  stream,
}: {
  onText: (text: string) => void
  stream: ReadableStream<Uint8Array> | null | undefined
}) => {
  if (!stream) {
    return Promise.resolve()
  }

  const reader = stream.getReader()

  return readBackendStream({decoder: new TextDecoder(), onText, reader})
    .catch((error) => {
      onText(`\n[desktop] failed to read backend stream: ${error instanceof Error ? error.message : String(error)}\n`)
    })
    .finally(() => {
      reader.releaseLock()
    })
}

const getStartupDetails = () => {
  const logTail = backendLogTail.trim()
  const existingPid =
    desktopSingleInstanceResult.status === 'already-running' ? desktopSingleInstanceResult.existing?.pid : null

  return [
    `apiOrigin=${runtimeConfig.apiOrigin}`,
    `dataRoot=${runtimeConfig.dataRoot}`,
    `logPath=${runtimeConfig.backendLogPath}`,
    `lockPath=${desktopSingleInstanceLockPath}`,
    existingPid === null ? null : `existingPid=${String(existingPid)}`,
    `command=${runtimeConfig.backendCommand.join(' ')}`,
    logTail === '' ? null : '',
    logTail === '' ? null : 'Recent backend log output:',
    logTail === '' ? null : logTail,
  ]
    .filter((value): value is string => {
      return value !== null
    })
    .join('\n')
}

if (desktopSingleInstanceResult.status === 'acquired') {
  writeFileSync(runtimeConfig.backendLogPath, `[desktop] backend session started ${new Date().toISOString()}\n`, 'utf8')
}

const getBackendProcessResult = () => {
  if (desktopSingleInstanceResult.status === 'already-running') {
    return {error: null, process: null} as const
  }

  try {
    return {
      error: null,
      process: globalThis.Bun.spawn(runtimeConfig.backendCommand, {
        cwd: runtimeConfig.dataRoot,
        env: runtimeConfig.backendEnv,
        stderr: 'pipe',
        stdout: 'pipe',
      }),
    } as const
  } catch (error) {
    return {error, process: null} as const
  }
}

const backendProcessResult = getBackendProcessResult()
const backendProcess = backendProcessResult.process
let backendReady = false
const startupWindow =
  desktopSingleInstanceResult.status === 'acquired'
    ? createWindow({
        frame: startupWindowFrame,
        preload: runtimeConfig.windowPreload,
        title: 'Starting Forska',
        url: getStartupSplashUrl(),
        viewsRoot: runtimeConfig.viewsRoot,
      })
    : null

void consumeBackendStream({
  onText: (text) => {
    appendBackendLog({text})
  },
  stream: backendProcess?.stdout,
})

void consumeBackendStream({
  onText: (text) => {
    appendBackendLog({text, writeToStderr: true})
  },
  stream: backendProcess?.stderr,
})

const stopBackend = () => {
  backendProcess?.kill()
  return desktopSingleInstanceResult.status === 'acquired' ? desktopSingleInstanceResult.release() : null
}

process.on('exit', stopBackend)
;(['SIGHUP', 'SIGINT', 'SIGTERM'] as const).map((signal) => {
  return process.on(signal, () => {
    stopBackend()
    process.exit(0)
  })
})

const respondToDesktopApiRequest = async ({
  bodyBase64,
  headers,
  id,
  mainWindow,
  method,
  path,
}: {
  bodyBase64: string | null
  headers: Array<[string, string]>
  id: string
  mainWindow: BrowserWindow
  method: string
  path: string
}) => {
  try {
    const response = await fetch(getDesktopApiRequestUrl({path}), {
      body: bodyBase64 === null ? undefined : Buffer.from(bodyBase64, 'base64'),
      headers,
      method,
    })

    mainWindow.webview.sendMessageToWebviewViaExecute({
      id,
      ok: true,
      response: {
        bodyBase64: Buffer.from(await response.arrayBuffer()).toString('base64'),
        headers: [...response.headers.entries()],
        status: response.status,
        statusText: response.statusText,
      },
      type: 'forska-desktop-api-response',
    })
  } catch (error) {
    mainWindow.webview.sendMessageToWebviewViaExecute({
      error: error instanceof Error ? error.message : String(error),
      id,
      ok: false,
      type: 'forska-desktop-api-response',
    })
  }
}

await (
  desktopSingleInstanceResult.status === 'already-running'
    ? Promise.reject(new Error('Forska desktop is already running in another process.'))
    : backendProcessResult.error === null && backendProcess !== null
      ? Promise.race([
          waitForBackendReady({
            apiOrigin: runtimeConfig.apiOrigin,
            deadlineMs: Date.now() + backendReadyTimeoutMs,
          }).then(() => {
            backendReady = true
          }),
          backendProcess.exited.then((exitCode) => {
            if (backendReady) {
              return
            }

            throw new Error(`Desktop backend exited before becoming ready (exit code ${String(exitCode)}).`)
          }),
        ])
      : Promise.reject(backendProcessResult.error)
)
  .then(() => {
    const mainWindow = createWindow({
      preload: runtimeConfig.windowPreload,
      title: 'Forska',
      url: runtimeConfig.windowUrl,
      viewsRoot: runtimeConfig.viewsRoot,
    })

    mainWindow.webview.rpcHandler = (message) => {
      const requestMessage = message as {
        id?: string
        request?: {bodyBase64?: string | null; headers?: Array<[string, string]>; method?: string; path?: string}
        type?: string
      }

      if (requestMessage.type !== 'forska-desktop-api-request') {
        return
      }

      const id = typeof requestMessage.id === 'string' ? requestMessage.id : null
      const request = requestMessage.request
      const path = typeof request?.path === 'string' ? request.path : null
      const method = typeof request?.method === 'string' ? request.method : null

      if (id === null || path === null || method === null) {
        return
      }

      void respondToDesktopApiRequest({
        bodyBase64: typeof request?.bodyBase64 === 'string' || request?.bodyBase64 === null ? request.bodyBase64 : null,
        headers: Array.isArray(request?.headers) ? request.headers : [],
        id,
        mainWindow,
        method,
        path,
      })
    }

    startupWindow?.close()
  })
  .catch((error) => {
    const errorMessage = error instanceof Error ? error.message : String(error)

    createWindow({
      preload: runtimeConfig.windowPreload,
      title: 'Forska Startup Error',
      viewsRoot: runtimeConfig.viewsRoot,
      url: getStartupErrorUrl({details: getStartupDetails(), message: errorMessage}),
    })
    startupWindow?.close()
  })
