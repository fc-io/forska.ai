import {spawn, spawnSync} from 'node:child_process'
import path from 'node:path'
import {parseArgs} from 'node:util'

import {getDefaultCodexAppServerHomeDir, prepareCodexAppServerHome} from '../src/server/utils/codexAppServerHome.ts'
import {
  codexAppServerInitializeParams,
  getCodexAppServerLaunchArgs,
  getCodexAppServerSpawnOptions,
  getCodexBinPath,
  getCodexDeclinedServerRequestResult,
  getCodexSafeCwd,
} from '../src/server/utils/getCodexAppServerClient.ts'

type JsonRpcMessage = {error?: unknown; id?: number; method?: string; params?: unknown; result?: unknown}

type Pending = {resolve: (message: JsonRpcMessage) => void}

type ProcessRow = {command: string; pid: number; ppid: number; rssKb: number}

type RequestResult = {durationMs: number; error: string | null; result: unknown}

const initializeTimeoutMs = 180_000
const threadStartTimeoutMs = 120_000

const {values} = parseArgs({
  options: {
    concurrency: {default: '35', type: 'string'},
    home: {type: 'string'},
    'max-p90-ms': {default: '2000', type: 'string'},
    model: {default: 'gpt-6-astra', type: 'string'},
  },
  strict: true,
})

const concurrency = Math.max(1, Number.parseInt(values.concurrency, 10))
const maxP90Ms = Number.parseInt(values['max-p90-ms'], 10)
const codexHome = values.home ? path.resolve(values.home) : getDefaultCodexAppServerHomeDir('probe')
const codexBin = getCodexBinPath()
const cwd = getCodexSafeCwd()

const log = (message: string) => {
  console.log(`[codex-probe] ${message}`)
}

const getQuantile = (sorted: number[], quantile: number) => {
  return sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] ?? Number.NaN
}

const readProcessTable = (): ProcessRow[] => {
  const output = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], {encoding: 'utf8'}).stdout ?? ''

  return output
    .split('\n')
    .map((line) => {
      return line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    })
    .filter((match): match is RegExpMatchArray => {
      return match !== null
    })
    .map((match) => {
      return {command: match[4] ?? '', pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3])}
    })
}

const getDescendants = (rows: ProcessRow[], pid: number): ProcessRow[] => {
  const children = rows.filter((row) => {
    return row.ppid === pid
  })

  return children.flatMap((child) => {
    return [child, ...getDescendants(rows, child.pid)]
  })
}

const getProcessNameCounts = (rows: ProcessRow[]) => {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const name = path.basename(row.command)
    return {...counts, [name]: (counts[name] ?? 0) + 1}
  }, {})
}

const pruned = await prepareCodexAppServerHome({appServerStopped: true, codexHome})
log(`bin=${codexBin} CODEX_HOME=${codexHome} cwd=${cwd} model=${values.model} concurrency=${concurrency}`)
log(
  `pruned ${pruned.sessionFiles} session files, ${pruned.archivedSessionFiles} archived, ${pruned.emptyDirectories} dirs, ${pruned.databaseFiles} sqlite files`,
)

const child = spawn(codexBin, getCodexAppServerLaunchArgs(), getCodexAppServerSpawnOptions(codexHome))
const pending = new Map<number, Pending>()
const stderrLines: string[] = []
let nextId = 1
let stdoutBuffer = ''

const write = (message: unknown) => {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

const handleMessage = (message: JsonRpcMessage) => {
  if (typeof message.id === 'number' && message.method === undefined) {
    pending.get(message.id)?.resolve(message)
    pending.delete(message.id)
    return
  }

  if (typeof message.id === 'number' && typeof message.method === 'string') {
    const declined = getCodexDeclinedServerRequestResult(message.method)
    write(
      declined
        ? {id: message.id, result: declined}
        : {error: {code: -32601, message: `Unsupported request: ${message.method}`}, id: message.id},
    )
  }
}

child.stdout.on('data', (data: Buffer) => {
  stdoutBuffer += data.toString('utf8')
  const lines = stdoutBuffer.split('\n')
  stdoutBuffer = lines.pop() ?? ''
  lines
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.startsWith('{')
    })
    .forEach((line) => {
      handleMessage(JSON.parse(line) as JsonRpcMessage)
    })
})

child.stderr.on('data', (data: Buffer) => {
  stderrLines.push(...data.toString('utf8').split('\n').filter(Boolean))
  stderrLines.splice(0, Math.max(0, stderrLines.length - 20))
})

const request = async (method: string, params: unknown, timeoutMs: number): Promise<RequestResult> => {
  const id = nextId
  nextId += 1
  const startedAt = performance.now()

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      resolve({durationMs: performance.now() - startedAt, error: `timeout after ${timeoutMs} ms`, result: null})
    }, timeoutMs)

    pending.set(id, {
      resolve: (message) => {
        clearTimeout(timeout)
        resolve({
          durationMs: performance.now() - startedAt,
          error: message.error === undefined ? null : JSON.stringify(message.error).slice(0, 300),
          result: message.result,
        })
      },
    })
    write({id, method, params})
  })
}

const stopChild = async () => {
  if (child.exitCode !== null || child.signalCode !== null) return

  const exited = new Promise((resolve) => {
    child.once('exit', resolve)
  })
  child.kill('SIGTERM')
  const timeout = setTimeout(() => {
    child.kill('SIGKILL')
  }, 10_000)
  await exited
  clearTimeout(timeout)
}

const initialize = await request('initialize', codexAppServerInitializeParams, initializeTimeoutMs)
log(`initialize: ${initialize.durationMs.toFixed(0)} ms${initialize.error ? ` error=${initialize.error}` : ''}`)

if (initialize.error) {
  stderrLines.forEach((line) => {
    log(`stderr ${line}`)
  })
  await stopChild()
  process.exit(1)
}

write({method: 'initialized', params: {}})

const results = await Promise.all(
  Array.from({length: concurrency}, async () => {
    return request('thread/start', {cwd, model: values.model}, threadStartTimeoutMs)
  }),
)
const accountRead = await request('account/read', {}, 30_000)
const account = (accountRead.result as {account?: {planType?: string; type?: string} | null} | null)?.account ?? null
log(`account: type=${account?.type ?? 'none'} plan=${account?.planType ?? 'none'}`)
const processRows = readProcessTable()
const appServerRssMb = Math.round(
  (processRows.find((row) => {
    return row.pid === child.pid
  })?.rssKb ?? 0) / 1024,
)
const childProcesses = getDescendants(processRows, child.pid ?? -1)
const childNameCounts = getProcessNameCounts(childProcesses)
const failures = results.filter((result) => {
  return result.error !== null
})
const durations = results
  .map((result) => {
    return result.durationMs
  })
  .sort((left, right) => {
    return left - right
  })
const p90 = getQuantile(durations, 0.9)
const nodeChildren = childProcesses.filter((row) => {
  return path.basename(row.command).toLowerCase().includes('node')
})

log(
  `thread/start x${concurrency}: ok=${results.length - failures.length} failed=${failures.length} min=${getQuantile(durations, 0).toFixed(0)} median=${getQuantile(durations, 0.5).toFixed(0)} p90=${p90.toFixed(0)} max=${(durations[durations.length - 1] ?? Number.NaN).toFixed(0)} ms`,
)
log(`app-server rss=${appServerRssMb} MB children=${JSON.stringify(childNameCounts)}`)
failures.slice(0, 3).forEach((failure) => {
  log(`failure ${failure.error}`)
})

await stopChild()

const problems = [
  account === null ? 'app-server is not logged in through the shared auth.json' : null,
  failures.length > 0 ? `${failures.length} thread/start requests failed` : null,
  p90 > maxP90Ms ? `p90 ${p90.toFixed(0)} ms exceeds ${maxP90Ms} ms` : null,
  nodeChildren.length > 0 ? `${nodeChildren.length} node child processes` : null,
].filter((problem): problem is string => {
  return problem !== null
})

if (problems.length > 0) {
  stderrLines.forEach((line) => {
    log(`stderr ${line}`)
  })
  log(`FAIL: ${problems.join('; ')}`)
  process.exit(1)
}

log('PASS')
