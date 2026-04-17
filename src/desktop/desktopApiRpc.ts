import type {RPCSchema} from 'electrobun/bun'

type EmptyRpcShape = Record<never, never>

export type DesktopApiRequest = {
  bodyBase64: string | null
  headers: Array<[string, string]>
  method: string
  path: string
}

export type DesktopApiResponse = {
  bodyBase64: string
  headers: Array<[string, string]>
  status: number
  statusText: string
}

export type DesktopApiRpc = {
  bun: RPCSchema<{
    requests: {fetchApi: {params: DesktopApiRequest; response: DesktopApiResponse}}
    messages: EmptyRpcShape
  }>
  webview: RPCSchema<{requests: EmptyRpcShape; messages: EmptyRpcShape}>
}
