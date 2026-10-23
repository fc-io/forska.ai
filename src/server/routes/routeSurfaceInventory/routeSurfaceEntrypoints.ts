import type {RouteSurfaceEntrypoint} from './routeSurfaceInventoryTypes.ts'

export const routeSurfaceEntrypoints: RouteSurfaceEntrypoint[] = [
  {
    category: 'supported-local-api',
    defaultBind: 'loopback',
    releaseDecision: 'Keep local-only. Mounts mixed product, diagnostics, internal runtime, and debug routes.',
    source: 'src/server/serverMain.ts',
    surface: 'API server listener on 127.0.0.1:${API_SERVER_PORT}',
  },
  {
    category: 'supported-local-api',
    defaultBind: 'loopback',
    releaseDecision: 'Keep local-only. Proxies /api and /api/* to the API server for the browser app.',
    source: 'src/appServerMain.ts',
    surface: 'Static app server listener on 127.0.0.1:${APP_SERVER_PORT}',
  },
  {
    category: 'internal-runtime-api',
    defaultBind: 'loopback',
    releaseDecision: 'Keep as split-runtime implementation detail. Unknown /api/* remains fail-closed.',
    source: 'src/server/routes/ApiProxyRoutes.ts',
    surface: 'DuckDB-owner proxy middleware for owner-dependent API routes',
  },
  {
    category: 'internal-runtime-api',
    defaultBind: 'loopback',
    releaseDecision:
      'Keep before the owner proxy. Blocks internal runtime and remove-before-release routes on the public local API.',
    source: 'src/server/routes/publicRouteSurfaceGate.ts',
    surface: 'Public local API route-surface gate',
  },
  {
    category: 'internal-runtime-api',
    defaultBind: 'loopback',
    releaseDecision:
      'Keep internal only. Mirrors product routes under /__duckdb-owner-rpc when this process owns DuckDB.',
    source: 'src/server/serverMain.ts',
    surface: '/__duckdb-owner-rpc/** owner-private route mirror',
  },
  {
    category: 'internal-runtime-api',
    defaultBind: 'process-local',
    releaseDecision: 'Keep role-gated. Jobs can call local/external runtimes and are not public HTTP API.',
    source: 'src/server/cron/*',
    surface: 'Maintenance and judging cron plugins mounted by server role',
  },
]
