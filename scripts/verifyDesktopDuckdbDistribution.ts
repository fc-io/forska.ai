import assert from 'node:assert/strict'
import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'

import {spawnSync} from 'bun'

import {pruneDuckdbPlatformPackages} from './verifyDuckdbDistribution/pruneDuckdbPlatformPackages.ts'

const desktopPlatforms: Record<string, string> = {macos: 'darwin', linux: 'linux', win: 'win32'}

export const getDesktopDistributionRoot = (envValues: Record<string, string | undefined>) => {
  const {ELECTROBUN_BUILD_DIR: buildDirectory, ELECTROBUN_APP_NAME: appName, ELECTROBUN_OS: platform} = envValues
  assert.ok(buildDirectory && appName && platform, 'Run this verifier as an Electrobun postBuild hook')
  return platform === 'macos'
    ? join(buildDirectory, `${appName}.app`, 'Contents', 'Resources', 'app')
    : join(buildDirectory, appName, 'Resources', 'app')
}

if (import.meta.main) {
  assert.equal(
    desktopPlatforms[process.env.ELECTROBUN_OS ?? ''],
    process.platform,
    'Build the desktop target on its native OS so the copied DuckDB engine can be verified',
  )
  assert.equal(
    process.env.ELECTROBUN_ARCH,
    process.arch,
    'Build the desktop target on its native architecture so the copied DuckDB engine can be verified',
  )
  const packageRoot = getDesktopDistributionRoot(process.env)
  assert.ok(existsSync(packageRoot), `Desktop app dependencies were not copied: ${packageRoot}`)
  console.log(
    'desktop-duckdb:removed-other-targets',
    pruneDuckdbPlatformPackages(join(packageRoot, 'node_modules'), process.platform, process.arch),
  )
  ;[
    'vendor/duckdb/manifest.json',
    'src/server/utils/duckdbEngineContract.ts',
    'src/server/utils/duckdbEngineCompatibility.ts',
    'src/server/utils/createDuckdbInstance.ts',
  ].map((path) => {
    return assert.equal(
      readFileSync(join(packageRoot, path), 'utf8'),
      readFileSync(join(import.meta.dir, '..', path), 'utf8'),
      `Desktop build did not copy the current engine contract: ${path}`,
    )
  })
  const result = spawnSync(
    [process.execPath, join(import.meta.dir, 'verifyDuckdbDistribution.ts'), `--package-root=${packageRoot}`],
    {stdout: 'inherit', stderr: 'inherit', timeout: 240000},
  )
  assert.equal(result.exitCode, 0, 'Desktop copied DuckDB distribution did not pass verification')
}
