import {resolve} from 'node:path'

export const buildPlaywrightApp = ({
  cwd = process.cwd(),
  envValues = process.env,
}: {cwd?: string; envValues?: Record<string, string | undefined>} = {}) => {
  const distDirectory = String(envValues.APP_SERVER_DIST_DIR ?? '').trim()

  if (!distDirectory) {
    throw new Error('APP_SERVER_DIST_DIR is required for an isolated Playwright build')
  }

  return globalThis.Bun.spawnSync(['bun', 'run', 'build', '--outDir', resolve(cwd, distDirectory), '--emptyOutDir'], {
    cwd,
    env: envValues,
    stderr: 'inherit',
    stdout: 'inherit',
  })
}
