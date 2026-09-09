import {mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

import {expect, test} from 'bun:test'

import {getAppServerRuntimeConfig} from '../src/server/utils/getAppServerRuntimeConfig.ts'
import {buildPlaywrightApp} from './buildPlaywrightApp.ts'
import {createScriptTestDirectory} from './testUtils/createScriptTestDirectory.ts'

test('Playwright builds require an explicit test-owned output directory', () => {
  expect(() => {
    return buildPlaywrightApp({envValues: {}})
  }).toThrow('APP_SERVER_DIST_DIR is required')
})

test('concurrent Playwright builds preserve independent API origins and unrelated output', async () => {
  const fixture = createScriptTestDirectory('playwright-build-isolation')
  const viteCliPath = resolve('node_modules/vite/bin/vite.js')
  const buildHelperPath = pathToFileURL(resolve('scripts/buildPlaywrightApp.ts')).href
  const firstDist = join(fixture.path, 'first-browser-dist')
  const secondDist = join(fixture.path, 'second-browser-dist')
  const defaultDist = join(fixture.path, 'dist')

  const startBuild = (distDirectory: string, origin: string) => {
    return globalThis.Bun.spawn(
      [
        'bun',
        '-e',
        `const {buildPlaywrightApp} = await import(${JSON.stringify(buildHelperPath)}); process.exit(buildPlaywrightApp().exitCode)`,
      ],
      {
        cwd: fixture.path,
        env: {...process.env, APP_SERVER_DIST_DIR: distDirectory, VITE_SERVER_API: origin},
        stderr: 'inherit',
        stdout: 'ignore',
      },
    )
  }
  const readBuiltJavaScript = (distDirectory: string) => {
    const assetDirectory = join(distDirectory, 'assets')

    return readdirSync(assetDirectory)
      .filter((file) => {
        return file.endsWith('.js')
      })
      .map((file) => {
        return readFileSync(join(assetDirectory, file), 'utf8')
      })
      .join('\n')
  }

  try {
    mkdirSync(defaultDist)
    writeFileSync(join(defaultDist, 'sentinel.txt'), 'existing development build')
    writeFileSync(
      join(fixture.path, 'package.json'),
      JSON.stringify({scripts: {build: 'bun build.ts'}, type: 'module'}),
    )
    writeFileSync(
      join(fixture.path, 'build.ts'),
      `const result = Bun.spawnSync(['bun', ${JSON.stringify(viteCliPath)}, 'build', ...process.argv.slice(2)], {stdout: 'inherit', stderr: 'inherit'}); process.exit(result.exitCode)`,
    )
    writeFileSync(join(fixture.path, 'index.html'), '<script type="module" src="/main.js"></script>')
    writeFileSync(join(fixture.path, 'main.js'), 'window.fixtureApiOrigin = import.meta.env.VITE_SERVER_API')

    const first = startBuild(firstDist, 'http://127.0.0.1:43100')
    const second = startBuild(secondDist, 'http://127.0.0.1:61015')
    expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0])

    const firstContents = readBuiltJavaScript(firstDist)
    const secondContents = readBuiltJavaScript(secondDist)
    expect(firstContents).toContain('http://127.0.0.1:43100')
    expect(firstContents).not.toContain('http://127.0.0.1:61015')
    expect(secondContents).toContain('http://127.0.0.1:61015')
    expect(secondContents).not.toContain('http://127.0.0.1:43100')
    expect(getAppServerRuntimeConfig({envValues: {APP_SERVER_DIST_DIR: firstDist}}).distDir).toBe(firstDist)
    expect(getAppServerRuntimeConfig({envValues: {APP_SERVER_DIST_DIR: secondDist}}).distDir).toBe(secondDist)
    expect(readFileSync(join(defaultDist, 'sentinel.txt'), 'utf8')).toBe('existing development build')
  } finally {
    fixture.cleanup()
  }
}, 30_000)
