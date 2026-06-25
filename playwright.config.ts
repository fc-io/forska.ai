import {defineConfig} from '@playwright/test'

import {getRuntimeProfileDuckdbPath} from './src/utils/runtimeProfile.ts'

const apiServerPort = 43101
const appServerPort = 43100
const syntheticDuckdbPath = '/tmp/forska-playwright-project-edit-smoke.duckdb'
const syntheticDuckdbTempDirectory = '/tmp/forska-playwright-project-edit-smoke.duckdb-temp'
const currentDuckdbTempDirectory = '/tmp/forska-playwright-current-network-smoke.duckdb-temp'
const networkSmokeLogDirectory = `/tmp/forska-playwright-network-smoke-runtime-logs-${process.pid}`
const networkSmokeDbMode = process.env.FORSKA_NETWORK_SMOKE_DB_MODE === 'current' ? 'current' : 'synthetic'
const currentDuckdbPath =
  process.env.FORSKA_NETWORK_SMOKE_DUCKDB_PATH
  ?? process.env.DUCKDB_PATH
  ?? getRuntimeProfileDuckdbPath({profileName: 'primary'})
const duckdbPath = networkSmokeDbMode === 'current' ? currentDuckdbPath : syntheticDuckdbPath
const duckdbTempDirectory =
  networkSmokeDbMode === 'current' ? currentDuckdbTempDirectory : syntheticDuckdbTempDirectory
const apiServerCommand =
  networkSmokeDbMode === 'current'
    ? `sh -c 'rm -rf "${duckdbTempDirectory}" "${networkSmokeLogDirectory}" && bun run build && bun run src/server/index.ts'`
    : `sh -c 'rm -f "${duckdbPath}" "${duckdbPath}.wal" && rm -rf "${duckdbTempDirectory}" "${networkSmokeLogDirectory}" && bun run build && bun run src/server/index.ts'`

const smokeEnv = {
  API_SERVER_PORT: String(apiServerPort),
  APP_SERVER_PORT: String(appServerPort),
  DUCKDB_PATH: duckdbPath,
  FORSKA_DISABLE_SERVER_MUTATIONS: networkSmokeDbMode === 'current' ? 'true' : 'false',
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
  RUN_SERVER_FULL_TEXT_FETCHING: 'false',
  LOG_DIR: networkSmokeLogDirectory,
  SERVER_ROLE: 'dev-single',
  SERVER_DUCKDB_OWNER_URL: '',
  VITE_PORT: String(appServerPort),
  VITE_SERVER_API: `http://127.0.0.1:${appServerPort}`,
}

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  use: {baseURL: `http://127.0.0.1:${appServerPort}`, screenshot: 'only-on-failure', trace: 'retain-on-failure'},
  webServer: [
    {
      command: apiServerCommand,
      env: {
        ...smokeEnv,
        DUCKDB_TEMP_DIRECTORY: duckdbTempDirectory,
        FORSKA_EXPOSE_LOCAL_OPERATOR_API: process.env.FORSKA_NETWORK_SMOKE_AUDIT === 'true' ? 'true' : 'false',
      },
      port: apiServerPort,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 180_000,
    },
    {
      command: 'bun run src/appServer.ts',
      env: smokeEnv,
      port: appServerPort,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    },
  ],
})
