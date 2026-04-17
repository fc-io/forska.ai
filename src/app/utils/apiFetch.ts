import type {DesktopApiRequest, DesktopApiResponse, DesktopApiRpc} from '../../desktop/desktopApiRpc.ts'
import {getDesktopApiOrigin} from './getDesktopApiOrigin.ts'

type ApiFetch = typeof globalThis.fetch
type DesktopApiRpcClient = {request: {fetchApi: (params: DesktopApiRequest) => Promise<DesktopApiResponse>}}

let desktopApiRpcPromise: Promise<DesktopApiRpcClient | null> | null = null
let _desktopElectroview: unknown

const getBase64FromArrayBuffer = (value: ArrayBuffer) => {
  const bytes = new Uint8Array(value)
  let binary = ''

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0)
  }

  return btoa(binary)
}

const getUint8ArrayFromBase64 = (value: string) => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

const isDesktopProtocol = (protocol: string | null | undefined) => {
  return protocol === 'views:' || protocol === 'file:'
}

const getDesktopApiPath = ({
  desktopApiOrigin,
  input,
  request,
}: {
  desktopApiOrigin: string | null
  input: RequestInfo | URL
  request: Request
}) => {
  if (typeof input === 'string' && input.startsWith('/')) {
    return input
  }

  const requestUrl = new URL(request.url)
  const resolvedDesktopApiOrigin = desktopApiOrigin ? new URL(desktopApiOrigin).origin : null

  return requestUrl.origin === resolvedDesktopApiOrigin ? `${requestUrl.pathname}${requestUrl.search}` : null
}

const getDesktopApiRpc = async (): Promise<DesktopApiRpcClient | null> => {
  if (typeof window === 'undefined' || !isDesktopProtocol(window.location.protocol)) {
    return null
  }

  if (desktopApiRpcPromise === null) {
    desktopApiRpcPromise = import('electrobun/view')
      .then(({Electroview}) => {
        const rpc = Electroview.defineRPC<DesktopApiRpc>({
          maxRequestTime: 120_000,
          handlers: {requests: {}, messages: {}},
        })

        _desktopElectroview = new Electroview({rpc})
        return rpc as DesktopApiRpcClient
      })
      .catch(() => {
        _desktopElectroview = null
        return null
      })
  }

  return desktopApiRpcPromise
}

const apiFetchImpl = async (input: Parameters<ApiFetch>[0], init?: Parameters<ApiFetch>[1]) => {
  const request = new Request(input, init)
  const desktopApiPath = getDesktopApiPath({desktopApiOrigin: getDesktopApiOrigin(), input, request})
  const desktopApiRpc = desktopApiPath === null ? null : await getDesktopApiRpc()

  if (desktopApiRpc === null || desktopApiPath === null) {
    return fetch(input, init)
  }

  const bodyBase64 =
    request.method === 'GET' || request.method === 'HEAD' ? null : getBase64FromArrayBuffer(await request.arrayBuffer())
  const response = await desktopApiRpc.request.fetchApi({
    bodyBase64,
    headers: [...request.headers.entries()],
    method: request.method,
    path: desktopApiPath,
  })

  return new Response(response.bodyBase64 === '' ? null : getUint8ArrayFromBase64(response.bodyBase64), {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  })
}

export const apiFetch = Object.assign(apiFetchImpl, {
  preconnect: globalThis.fetch.preconnect?.bind(globalThis.fetch),
}) as ApiFetch
