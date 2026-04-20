import {bootstrapAppServerRuntime} from './server/utils/runtimeBootstrap.ts'

bootstrapAppServerRuntime()
await import('./appServerMain.ts')

export type {App} from './appServerMain.ts'
