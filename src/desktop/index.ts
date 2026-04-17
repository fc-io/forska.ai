import {appendFileSync, writeFileSync} from 'node:fs'

import {BrowserWindow} from 'electrobun/bun'

import {getDesktopRuntimeConfig} from './getDesktopRuntimeConfig.ts'

const backendReadyPollIntervalMs = 250
const backendReadyTimeoutMs = 30_000
const backendLogTailMaxChars = 12_000

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

const createWindow = ({
  preload,
  title,
  url,
  viewsRoot,
}: {
  preload: string
  title: string
  url: string
  viewsRoot: string
}) => {
  return new BrowserWindow({frame: {height: 980, width: 1440, x: 120, y: 80}, preload, title, url, viewsRoot})
}

const runtimeConfig = getDesktopRuntimeConfig()
let backendLogTail = ''

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

  return [
    `apiOrigin=${runtimeConfig.apiOrigin}`,
    `dataRoot=${runtimeConfig.dataRoot}`,
    `logPath=${runtimeConfig.backendLogPath}`,
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

writeFileSync(runtimeConfig.backendLogPath, `[desktop] backend session started ${new Date().toISOString()}\n`, 'utf8')

const getBackendProcessResult = () => {
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
}

process.on('exit', stopBackend)
;(['SIGHUP', 'SIGINT', 'SIGTERM'] as const).map((signal) => {
  return process.on(signal, () => {
    stopBackend()
    process.exit(0)
  })
})

await (
  backendProcessResult.error === null && backendProcess !== null
    ? Promise.race([
        waitForBackendReady({apiOrigin: runtimeConfig.apiOrigin, deadlineMs: Date.now() + backendReadyTimeoutMs}).then(
          () => {
            backendReady = true
          },
        ),
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
    createWindow({
      preload: runtimeConfig.windowPreload,
      title: 'Forska',
      url: runtimeConfig.windowUrl,
      viewsRoot: runtimeConfig.viewsRoot,
    })
  })
  .catch((error) => {
    const errorMessage = error instanceof Error ? error.message : String(error)

    createWindow({
      preload: runtimeConfig.windowPreload,
      title: 'Forska Startup Error',
      viewsRoot: runtimeConfig.viewsRoot,
      url: getStartupErrorUrl({details: getStartupDetails(), message: errorMessage}),
    })
  })
