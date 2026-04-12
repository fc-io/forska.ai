import {defineConfig} from '@playwright/test'

const apiServerPort = 43101
const appServerPort = 43100
const duckdbPath = '/tmp/forska-playwright-project-edit-smoke.duckdb'

const smokeEnv = {
  API_SERVER_PORT: String(apiServerPort),
  APP_SERVER_PORT: String(appServerPort),
  DUCKDB_PATH: duckdbPath,
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
  RUN_SERVER_FULL_TEXT_FETCHING: 'false',
  SERVER_ROLE: 'dev-single',
  SERVER_WRITER_URL: '',
  VITE_PORT: String(appServerPort),
}

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  use: {baseURL: `http://127.0.0.1:${appServerPort}`, screenshot: 'only-on-failure', trace: 'retain-on-failure'},
  webServer: [
    {
      command: `sh -c 'rm -f "${duckdbPath}" "${duckdbPath}.wal" && rm -rf "/tmp/forska-playwright-project-edit-smoke.duckdb-temp" && bun run build && bun run src/server/index.ts'`,
      env: {...smokeEnv, DUCKDB_TEMP_DIRECTORY: '/tmp/forska-playwright-project-edit-smoke.duckdb-temp'},
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
