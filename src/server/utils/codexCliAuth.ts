import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'

import {getCodexBinPath} from './getCodexAppServerClient.ts'

type CodexLoginMethod = 'chatgpt' | 'api-key'

type CodexCliLoginStatus = {ok: boolean; loggedIn: boolean; method: CodexLoginMethod | null; raw: string}

type CodexDeviceLoginJobState = 'running' | 'completed' | 'failed'

export type CodexDeviceLoginJob = {
  id: string
  state: CodexDeviceLoginJobState
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  signal: string | null
  output: string[]
  deviceUrl: string | null
  deviceCode: string | null
  error: string | null
}

const stripAnsi = (value: string): string => {
  const pattern = '[\\u001B\\u009B][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]'
  return value.replace(new RegExp(pattern, 'g'), '')
}

const normalizeLines = (value: string): string[] => {
  return stripAnsi(value)
    .split(/\r?\n/g)
    .map((l) => {
      return l.trimEnd()
    })
}

const getCodexLoginMethod = (raw: string): CodexLoginMethod | null => {
  const lower = raw.toLowerCase()
  return lower.includes('chatgpt') ? 'chatgpt' : lower.includes('api key') ? 'api-key' : null
}

export const getCodexCliLoginStatus = async (): Promise<CodexCliLoginStatus> => {
  const codexBin = getCodexBinPath()
  return await new Promise((resolve) => {
    const proc = spawn(codexBin, ['login', 'status'], {stdio: ['ignore', 'pipe', 'pipe']})
    let out = ''
    let err = ''
    const done = (ok: boolean) => {
      const combined = [out, err].filter(Boolean).join('\n')
      const raw = stripAnsi(combined).trim()
      const loggedIn = raw.toLowerCase().includes('logged in')
      resolve({ok, loggedIn, method: loggedIn ? getCodexLoginMethod(raw) : null, raw})
    }

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM')
      done(false)
    }, 2_000)

    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    proc.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf8')
    })
    proc.on('error', () => {
      clearTimeout(timeout)
      done(false)
    })
    proc.on('exit', (code) => {
      clearTimeout(timeout)
      done(code === 0)
    })
  })
}

const MAX_OUTPUT_LINES = 160

const appendOutput = (prev: string[], nextLines: string[]): string[] => {
  const combined = [...prev, ...nextLines]
  const trimmed = combined.filter((l) => {
    return l.trim().length > 0
  })
  return trimmed.length > MAX_OUTPUT_LINES ? trimmed.slice(trimmed.length - MAX_OUTPUT_LINES) : trimmed
}

const getDeviceUrlFromOutput = (lines: string[]): string | null => {
  const match = lines
    .map((l) => {
      return l.match(/https?:\/\/\S+/)
    })
    .find((m) => {
      return Boolean(m)
    })
  return match?.[0] ?? null
}

const getDeviceCodeFromOutput = (lines: string[]): string | null => {
  const match = lines
    .map((l) => {
      return l.match(/[A-Z0-9]{4,}-[A-Z0-9]{4,}/)
    })
    .find((m) => {
      return Boolean(m)
    })
  return match?.[0] ?? null
}

let currentJob: CodexDeviceLoginJob | null = null

export const startCodexDeviceAuthLogin = (): CodexDeviceLoginJob => {
  if (currentJob && currentJob.state === 'running') return currentJob

  const codexBin = getCodexBinPath()
  const id = randomUUID()
  const startedAt = new Date().toISOString()

  const job: CodexDeviceLoginJob = {
    id,
    state: 'running',
    startedAt,
    finishedAt: null,
    exitCode: null,
    signal: null,
    output: [],
    deviceUrl: null,
    deviceCode: null,
    error: null,
  }
  currentJob = job

  const proc = spawn(codexBin, ['login', '--device-auth'], {stdio: ['ignore', 'pipe', 'pipe']})

  const updateFromText = (text: string) => {
    job.output = appendOutput(job.output, normalizeLines(text))
    job.deviceUrl = job.deviceUrl ?? getDeviceUrlFromOutput(job.output)
    job.deviceCode = job.deviceCode ?? getDeviceCodeFromOutput(job.output)
  }

  proc.stdout.on('data', (d: Buffer) => {
    updateFromText(d.toString('utf8'))
  })
  proc.stderr.on('data', (d: Buffer) => {
    updateFromText(d.toString('utf8'))
  })

  const timeout = setTimeout(
    () => {
      if (job.state !== 'running') return
      proc.kill('SIGTERM')
      job.state = 'failed'
      job.finishedAt = new Date().toISOString()
      job.error = 'Login timed out'
    },
    20 * 60 * 1000,
  )

  proc.on('error', (error) => {
    clearTimeout(timeout)
    job.state = 'failed'
    job.finishedAt = new Date().toISOString()
    job.error = error instanceof Error ? error.message : String(error)
  })
  proc.on('exit', (code, signal) => {
    clearTimeout(timeout)
    job.exitCode = code
    job.signal = signal
    job.finishedAt = new Date().toISOString()
    job.state = code === 0 ? 'completed' : 'failed'
    if (code !== 0) job.error = job.error ?? `codex login exited (code=${String(code)}, signal=${String(signal)})`
  })

  return job
}

export const getCodexDeviceAuthLoginJob = (id: string): CodexDeviceLoginJob | null => {
  return currentJob?.id === id ? currentJob : null
}

export const getCurrentCodexDeviceAuthLoginJob = (): CodexDeviceLoginJob | null => {
  return currentJob
}
