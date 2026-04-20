import {bootstrapServerRuntime} from './utils/runtimeBootstrap.ts'

bootstrapServerRuntime()
await import('./serverMain.ts')

export type {App} from './serverMain.ts'
