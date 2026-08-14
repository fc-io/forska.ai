import {existsSync} from 'node:fs'
import {join, resolve} from 'node:path'

type PlaywrightArgs = {env: Record<string, string | undefined>; passthroughArgs: string[]}

export const parseRunPlaywrightArgs = (argv: string[]): PlaywrightArgs => {
  const env: Record<string, string | undefined> = {}
  const passthroughArgs: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg !== '--env') {
      passthroughArgs.push(arg)
      continue
    }

    const envEntry = argv[index + 1]

    if (envEntry === undefined) {
      throw new Error('Expected KEY=value after --env')
    }

    const equalsIndex = envEntry.indexOf('=')

    if (equalsIndex <= 0) {
      throw new Error(`Expected --env KEY=value, received ${envEntry}`)
    }

    env[envEntry.slice(0, equalsIndex)] = envEntry.slice(equalsIndex + 1)
    index += 1
  }

  return {env, passthroughArgs}
}

const getNodeExecutable = () => {
  const configuredNodeExecutable = String(process.env.FORSKA_PLAYWRIGHT_NODE_BIN ?? '').trim()
  const scoopRoot = String(process.env.SCOOP ?? '').trim()
  const userProfile = String(process.env.USERPROFILE ?? '').trim()
  const programFiles = String(process.env.ProgramFiles ?? '').trim()
  const discoveredNodeExecutable = globalThis.Bun.which('node')
  const nodeCandidates = configuredNodeExecutable
    ? [configuredNodeExecutable]
    : [
        discoveredNodeExecutable,
        process.platform === 'win32' && scoopRoot ? join(scoopRoot, 'apps', 'nodejs-lts', 'current', 'node.exe') : null,
        process.platform === 'win32' && userProfile
          ? join(userProfile, 'scoop', 'apps', 'nodejs-lts', 'current', 'node.exe')
          : null,
        process.platform === 'win32' && programFiles ? join(programFiles, 'nodejs', 'node.exe') : null,
      ]

  const nodeExecutable = nodeCandidates.find((candidate): candidate is string => {
    if (!candidate || !existsSync(candidate)) {
      return false
    }

    const probe = globalThis.Bun.spawnSync(
      [
        candidate,
        '-e',
        "const major = Number(process.versions.node.split('.')[0]); process.exit(!process.versions.bun && major >= 18 ? 0 : 1)",
      ],
      {stderr: 'ignore', stdout: 'ignore'},
    )

    return probe.success
  })

  if (!nodeExecutable) {
    const configuredHint = configuredNodeExecutable
      ? ` The configured FORSKA_PLAYWRIGHT_NODE_BIN is not a usable Node.js 18+ executable: ${configuredNodeExecutable}`
      : ''

    throw new Error(
      `Playwright requires a real Node.js 18+ runtime on Windows; Bun's node compatibility shim cannot control Chromium.${configuredHint} Install Node.js LTS or set FORSKA_PLAYWRIGHT_NODE_BIN.`,
    )
  }

  return nodeExecutable
}

const runPlaywright = () => {
  const playwrightCliPath = resolve(import.meta.dir, '../node_modules/@playwright/test/cli.js')
  const {env, passthroughArgs} = parseRunPlaywrightArgs(process.argv.slice(2))
  const playwright = globalThis.Bun.spawnSync([getNodeExecutable(), playwrightCliPath, 'test', ...passthroughArgs], {
    cwd: process.cwd(),
    env: {...process.env, ...env},
    stderr: 'inherit',
    stdin: 'inherit',
    stdout: 'inherit',
  })

  process.exit(playwright.exitCode ?? 1)
}

if (import.meta.main) {
  runPlaywright()
}
