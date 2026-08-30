import {randomUUID} from 'node:crypto'
import {existsSync} from 'node:fs'
import {join, resolve} from 'node:path'

import {listen, sleep, spawn, type Subprocess} from 'bun'

import {duckdbOwnerPrivateApiPrefix} from '../src/server/routes/apiRouteClassification.ts'
import {
  createJudgmentWorkflowTopology,
  startJudgmentWorkflowTopology,
  startJudgmentWorkflowTopologyProvider,
  stopJudgmentWorkflowTopology,
} from './judgmentWorkflowTopology.ts'

type AppProcess = Subprocess<'ignore', 'pipe', 'pipe'>

const getAvailablePort = () => {
  const server = listen({hostname: '127.0.0.1', port: 0, socket: {data() {}}})
  const port = server.port
  server.stop(true)
  return port
}

const postJson = async <T>(url: string, body: unknown): Promise<T> => {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {'content-type': 'application/json'},
    method: 'POST',
  })
  const text = await response.text()

  if (!response.ok) {
    throw new Error(`Browser fixture request failed (${response.status}) ${url}: ${text}`)
  }

  return JSON.parse(text) as T
}

const waitForApp = async (url: string, deadline: number): Promise<void> => {
  const ready = await fetch(url)
    .then((response) => {
      return response.ok
    })
    .catch(() => {
      return false
    })

  if (ready) {
    return
  }

  if (Date.now() >= deadline) {
    throw new Error(`Timed out waiting for browser app at ${url}`)
  }

  await sleep(100)
  return waitForApp(url, deadline)
}

const getNodeExecutable = () => {
  const configured = String(process.env.FORSKA_PLAYWRIGHT_NODE_BIN ?? '').trim()
  const discovered = globalThis.Bun.which('node')
  const candidates = configured
    ? [configured]
    : [
        discovered,
        process.platform === 'win32' && process.env.SCOOP
          ? join(process.env.SCOOP, 'apps', 'nodejs-lts', 'current', 'node.exe')
          : null,
        process.platform === 'win32' && process.env.ProgramFiles
          ? join(process.env.ProgramFiles, 'nodejs', 'node.exe')
          : null,
      ]
  const node = candidates.find((candidate): candidate is string => {
    if (!candidate || !existsSync(candidate)) return false

    return globalThis.Bun.spawnSync(
      [
        candidate,
        '-e',
        "const major=Number(process.versions.node.split('.')[0]);process.exit(!process.versions.bun&&major>=18?0:1)",
      ],
      {stderr: 'ignore', stdout: 'ignore'},
    ).success
  })

  if (!node) {
    throw new Error('A real Node.js 18+ executable is required for the judgment workflow browser smoke')
  }

  return node
}

const stopApp = async (app: AppProcess | null) => {
  if (!app || app.exitCode !== null) {
    return
  }

  app.kill('SIGTERM')
  await Promise.race([app.exited, sleep(10_000)])

  if (app.exitCode === null) {
    app.kill('SIGKILL')
    await app.exited
  }
}

const main = async () => {
  const provider = startJudgmentWorkflowTopologyProvider()
  const topology = createJudgmentWorkflowTopology()
  let running: Awaited<ReturnType<typeof startJudgmentWorkflowTopology>> | null = null
  const appPort = getAvailablePort()
  const appOrigin = `http://127.0.0.1:${appPort}`
  const ownerOrigin = `http://127.0.0.1:${topology.maintenancePort}${duckdbOwnerPrivateApiPrefix}`
  const fixtureId = `browser-${randomUUID()}`
  const token = topology.env.FORSKA_TEST_JUDGMENT_TOPOLOGY_SEED_TOKEN
  let app: AppProcess | null = null

  try {
    running = await startJudgmentWorkflowTopology({topology})
    const seeded = await postJson<{
      data: {
        fixture: {
          articleIds: string[]
          modelId: string
          pausedJobId: string | null
          projectIds: string[]
          promptIds: string[]
        }
      }
    }>(`${ownerOrigin}/api/test/judgment-workflow-topology/seed`, {
      createPausedJob: true,
      fixtureId,
      providerBaseUrl: provider.baseUrl,
      token,
    })
    const waitForServing = async (deadline: number): Promise<void> => {
      const evidence = await postJson<{data: {readyPairCount: number}}>(
        `${ownerOrigin}/api/test/judgment-workflow-topology/evidence`,
        {fixtureId, token},
      )

      if (evidence.data.readyPairCount === 4) return
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for browser fixture serving rows`)
      await sleep(100)
      return waitForServing(deadline)
    }
    await waitForServing(Date.now() + 60_000)
    const projectId = seeded.data.fixture.projectIds[0]
    const articleId = seeded.data.fixture.articleIds[0]
    const jobId = seeded.data.fixture.pausedJobId

    if (!projectId || !articleId || !jobId) {
      throw new Error('Browser topology seed omitted its primary project, article, or paused job')
    }
    const buildEnv = {
      ...process.env,
      API_SERVER_PORT: String(topology.apiPort),
      APP_SERVER_PORT: String(appPort),
      VITE_PORT: String(appPort),
      VITE_SERVER_API: appOrigin,
    }
    const build = globalThis.Bun.spawnSync(['bun', 'run', 'build'], {
      env: buildEnv,
      stderr: 'inherit',
      stdout: 'inherit',
    })

    if (!build.success) {
      throw new Error(`Browser fixture app build failed with code ${build.exitCode}`)
    }

    app = spawn(['bun', 'scripts/startPlaywrightAppServer.ts'], {
      env: buildEnv,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    })
    await waitForApp(appOrigin, Date.now() + 60_000)
    const playwrightCli = resolve('node_modules/@playwright/test/cli.js')
    const playwright = spawn(
      [getNodeExecutable(), playwrightCli, 'test', '--config', 'scripts/playwrightJudgmentWorkflowConfig.ts'],
      {
        env: {
          ...process.env,
          FORSKA_JUDGMENT_BROWSER_APP_PORT: String(appPort),
          FORSKA_JUDGMENT_BROWSER_ARTICLE_ID: articleId,
          FORSKA_JUDGMENT_BROWSER_FIXTURE_ID: fixtureId,
          FORSKA_JUDGMENT_BROWSER_JOB_ID: jobId,
          FORSKA_JUDGMENT_BROWSER_MODEL_ID: seeded.data.fixture.modelId,
          FORSKA_JUDGMENT_BROWSER_OWNER_ORIGIN: ownerOrigin,
          FORSKA_JUDGMENT_BROWSER_PROJECT_ID: projectId,
          FORSKA_JUDGMENT_BROWSER_PROJECT_NAME: 'Topology project A',
          FORSKA_JUDGMENT_BROWSER_PROMPT_ID: seeded.data.fixture.promptIds[0] ?? '',
          FORSKA_JUDGMENT_BROWSER_SEED_TOKEN: token,
        },
        stdin: 'inherit',
        stderr: 'inherit',
        stdout: 'inherit',
      },
    )
    const playwrightExitCode = await playwright.exited

    if (playwrightExitCode !== 0) {
      throw new Error(`Judgment workflow browser smoke failed with code ${playwrightExitCode}`)
    }
  } finally {
    try {
      await stopApp(app)
    } finally {
      try {
        if (running) await stopJudgmentWorkflowTopology(running)
      } finally {
        provider.close()
      }
    }
  }
}

await main()
