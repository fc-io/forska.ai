import {defineConfig} from '@playwright/test'

const appPort = process.env.FORSKA_JUDGMENT_BROWSER_APP_PORT

if (!appPort) {
  throw new Error('FORSKA_JUDGMENT_BROWSER_APP_PORT is required')
}

const config = defineConfig({
  testDir: '.',
  testMatch: 'judgmentWorkflowBrowser.spec.ts',
  timeout: 180_000,
  workers: 1,
  use: {baseURL: `http://127.0.0.1:${appPort}`, screenshot: 'only-on-failure', trace: 'retain-on-failure'},
})

// Playwright discovers configuration through this required default export.
// eslint-disable-next-line import/no-default-export
export default config
