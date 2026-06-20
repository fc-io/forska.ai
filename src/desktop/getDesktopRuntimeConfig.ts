import {mkdirSync} from 'node:fs'
import {homedir} from 'node:os'
import {posix, resolve, win32} from 'node:path'

import {getRuntimeLogConfig} from '../server/utils/runtimeLogger.ts'

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
    `
window.__FORSKA_DESKTOP_API_ORIGIN__ = ${JSON.stringify(apiOrigin)};
(() => {
  const desktopApiOrigin = ${JSON.stringify(apiOrigin)};
  const originalFetch = window.fetch.bind(window);
  const originalReceiveMessageFromBun = window.__electrobun.receiveMessageFromBun;
  const pendingRequests = new Map();
  let nextRequestId = 0;

  const getBase64FromArrayBuffer = (value) => {
    const bytes = new Uint8Array(value);
    let binary = '';

    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index] ?? 0);
    }

    return btoa(binary);
  };

  const getUint8ArrayFromBase64 = (value) => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  };

  const getDesktopApiPath = (request) => {
    const requestUrl = new URL(request.url);
    const desktopApiUrl = new URL(desktopApiOrigin);

    if (requestUrl.origin === desktopApiUrl.origin) {
      return requestUrl.pathname + requestUrl.search;
    }

    return requestUrl.pathname.startsWith('/api/') ? requestUrl.pathname + requestUrl.search : null;
  };

  window.__electrobun.receiveMessageFromBun = (message) => {
    if (message?.type === 'forska-desktop-api-response') {
      const pendingRequest = pendingRequests.get(message.id);

      if (!pendingRequest) {
        return;
      }

      pendingRequests.delete(message.id);

      if (message.ok) {
        pendingRequest.resolve(
          new Response(
            message.response.bodyBase64 === '' ? null : getUint8ArrayFromBase64(message.response.bodyBase64),
            {
              headers: message.response.headers,
              status: message.response.status,
              statusText: message.response.statusText,
            },
          ),
        );

        return;
      }

      pendingRequest.reject(new Error(message.error ?? 'Desktop API bridge request failed.'));
      return;
    }

    originalReceiveMessageFromBun(message);
  };

  const patchedFetch = async (input, init) => {
    const request = new Request(input, init);
    const desktopApiPath = getDesktopApiPath(request);

    if (desktopApiPath === null) {
      return originalFetch(input, init);
    }

    return new Promise(async (resolve, reject) => {
      const requestId = String(++nextRequestId);

      pendingRequests.set(requestId, {reject, resolve});

      const bodyBase64 =
        request.method === 'GET' || request.method === 'HEAD' ? null : getBase64FromArrayBuffer(await request.arrayBuffer());

      window.__electrobunBunBridge?.postMessage(
        JSON.stringify({
          id: requestId,
          request: {
            bodyBase64,
            headers: [...request.headers.entries()],
            method: request.method,
            path: desktopApiPath,
          },
          type: 'forska-desktop-api-request',
        }),
      );
    });
  };

  patchedFetch.preconnect = originalFetch.preconnect?.bind(originalFetch);
  window.fetch = patchedFetch;
})();
`.trim(),
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
  const apiServerPort = getTrimmedValue(envValues.FORSKA_DESKTOP_API_SERVER_PORT) ?? desktopDefaultApiServerPort
  const apiOrigin = `http://127.0.0.1:${apiServerPort}`
  const serverEntryPath = resolve(import.meta.dir, '../server/index.ts')
  const backendCommand = [getDesktopBunBinary(envValues), serverEntryPath]
  const backendEnv: Record<string, string | undefined> = {
    ...envValues,
    API_SERVER_PORT: apiServerPort,
    DUCKDB_PATH: pathModule.join(dataRoot, 'forska.duckdb'),
    DUCKDB_MEMORY_LIMIT: getTrimmedValue(envValues.DUCKDB_MEMORY_LIMIT) ?? '6400MiB',
    FORSKA_DESKTOP_MODE: 'true',
    FORSKA_RUNTIME_PROFILE: 'local',
    FORSKA_RUNTIME_SERVICE: 'dev-single-server',
    JUDGE_WORKER_ID: 'desktop-judge-worker',
    SERVER_DUCKDB_OWNER_URL: '',
    SERVER_ROLE: 'dev-single',
  }
  const runtimeLogConfig = getRuntimeLogConfig({
    cwd: dataRoot,
    envValues: backendEnv,
    joinPath: (...paths) => {
      return pathModule.join(...paths)
    },
    runtimeWritableRoot: dataRoot,
  })
  backendEnv.LOG_DIR = runtimeLogConfig.logDir
  backendEnv.LOG_LEVEL = runtimeLogConfig.logLevel
  backendEnv.LOG_STDERR_LEVEL = runtimeLogConfig.logStderrLevel
  const backendLogPath = pathModule.resolve(runtimeLogConfig.logDir, 'backend.log')

  if (createDataRoot) {
    mkdirSync(dataRoot, {recursive: true})
    mkdirSync(runtimeLogConfig.logDir, {recursive: true})
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
