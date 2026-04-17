import {mkdirSync} from 'node:fs'
import {homedir} from 'node:os'
import {posix, resolve, win32} from 'node:path'

type Platform = typeof process.platform
type PathModule = typeof posix

type DesktopRuntimeConfig = {
  apiOrigin: string
  apiServerPort: string
  backendCommand: string[]
  backendEnv: Record<string, string | undefined>
  backendLogPath: string
  dataRoot: string
  windowPreload: string
  viewsRoot: string
  windowUrl: string
}

const desktopDefaultApiServerPort = '32101'

const getDesktopWindowPreload = (apiOrigin: string) => {
  return `data:text/javascript;base64,${Buffer.from(
    `window.__FORSKA_DESKTOP_API_ORIGIN__ = ${JSON.stringify(apiOrigin)};`,
    'utf8',
  ).toString('base64')}`
}

const getPathModule = (platform: Platform): PathModule => {
  return platform === 'win32' ? win32 : posix
}

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalizedValue = String(value ?? '').trim()

  return normalizedValue === '' ? null : normalizedValue
}

const getWindowsDataRoot = ({
  envValues,
  homeDirectory,
  pathModule,
}: {
  envValues: Record<string, string | undefined>
  homeDirectory: string
  pathModule: PathModule
}) => {
  return getTrimmedValue(envValues.LOCALAPPDATA) ?? pathModule.join(homeDirectory, 'AppData', 'Local')
}

const getLinuxDataRoot = ({
  envValues,
  homeDirectory,
  pathModule,
}: {
  envValues: Record<string, string | undefined>
  homeDirectory: string
  pathModule: PathModule
}) => {
  return getTrimmedValue(envValues.XDG_DATA_HOME) ?? pathModule.join(homeDirectory, '.local', 'share')
}

const getDesktopDataRoot = ({
  envValues,
  homeDirectory,
  platform,
}: {
  envValues: Record<string, string | undefined>
  homeDirectory: string
  platform: Platform
}) => {
  const pathModule = getPathModule(platform)

  return platform === 'darwin'
    ? pathModule.join(homeDirectory, 'Library', 'Application Support', 'Forska', 'desktop')
    : platform === 'win32'
      ? pathModule.join(getWindowsDataRoot({envValues, homeDirectory, pathModule}), 'Forska', 'desktop')
      : pathModule.join(getLinuxDataRoot({envValues, homeDirectory, pathModule}), 'forska', 'desktop')
}

const getDesktopBunBinary = (envValues: Record<string, string | undefined>) => {
  return getTrimmedValue(envValues.FORSKA_DESKTOP_BUN_BIN) ?? globalThis.Bun.which('bun') ?? 'bun'
}

export const getDesktopRuntimeConfig = ({
  createDataRoot = true,
  envValues = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
}: {
  createDataRoot?: boolean
  envValues?: Record<string, string | undefined>
  homeDirectory?: string
  platform?: Platform
} = {}): DesktopRuntimeConfig => {
  const dataRoot = getDesktopDataRoot({envValues, homeDirectory, platform})
  const pathModule = getPathModule(platform)
  const backendLogPath = pathModule.resolve(dataRoot, 'logs', 'backend.log')
  const apiServerPort = getTrimmedValue(envValues.FORSKA_DESKTOP_API_SERVER_PORT) ?? desktopDefaultApiServerPort
  const apiOrigin = `http://127.0.0.1:${apiServerPort}`
  const serverEntryPath = resolve(import.meta.dir, '../src/server/index.ts')
  const backendCommand = [getDesktopBunBinary(envValues), serverEntryPath]
  const backendEnv = {
    ...envValues,
    API_SERVER_PORT: apiServerPort,
    DUCKDB_PATH: pathModule.join(dataRoot, 'forska.duckdb'),
    FORSKA_DESKTOP_MODE: 'true',
    SERVER_ROLE: 'dev-single',
    SERVER_WRITER_URL: '',
  }

  if (createDataRoot) {
    mkdirSync(dataRoot, {recursive: true})
    mkdirSync(resolve(dataRoot, 'logs'), {recursive: true})
  }

  return {
    apiOrigin,
    apiServerPort,
    backendCommand,
    backendEnv,
    backendLogPath,
    dataRoot,
    windowPreload: getDesktopWindowPreload(apiOrigin),
    viewsRoot: resolve(import.meta.dir, '../views'),
    windowUrl: 'views://mainview/index.html',
  }
}
