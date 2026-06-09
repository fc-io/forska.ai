import {afterEach, expect, test} from 'bun:test'

import {uploadProjectImportPackage} from './projectImportClient.ts'

type MockListener = (event?: {loaded: number}) => void

class MockEventTarget {
  private listeners = new Map<string, MockListener[]>()

  addEventListener(type: string, listener: MockListener) {
    const currentListeners = this.listeners.get(type) ?? []

    this.listeners.set(type, [...currentListeners, listener])
  }

  dispatch(type: string, event?: {loaded: number}) {
    ;(this.listeners.get(type) ?? []).forEach((listener) => {
      listener(event)
    })
  }
}

class MockXMLHttpRequest extends MockEventTarget {
  static lastInstance: MockXMLHttpRequest | null = null
  static nextResponseText = ''
  static nextStatus = 200

  headers: Record<string, string> = {}
  method = ''
  responseText = ''
  sentBody: File | null = null
  upload = new MockEventTarget()
  url = ''
  withCredentials = false

  constructor() {
    super()
    MockXMLHttpRequest.lastInstance = this
  }

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }

  send(body: File) {
    this.sentBody = body
    this.status = MockXMLHttpRequest.nextStatus
    this.responseText = MockXMLHttpRequest.nextResponseText
    this.upload.dispatch('progress', {loaded: body.size})
    this.dispatch('load')
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }

  status = 0
}

const originalWindow = Reflect.get(globalThis, 'window')
const originalXmlHttpRequest = Reflect.get(globalThis, 'XMLHttpRequest')

const restoreWindow = () => {
  return originalWindow === undefined
    ? Reflect.deleteProperty(globalThis, 'window')
    : Object.defineProperty(globalThis, 'window', {configurable: true, value: originalWindow, writable: true})
}

const restoreXmlHttpRequest = () => {
  return originalXmlHttpRequest === undefined
    ? Reflect.deleteProperty(globalThis, 'XMLHttpRequest')
    : Object.defineProperty(globalThis, 'XMLHttpRequest', {
        configurable: true,
        value: originalXmlHttpRequest,
        writable: true,
      })
}

afterEach(() => {
  MockXMLHttpRequest.lastInstance = null
  MockXMLHttpRequest.nextResponseText = ''
  MockXMLHttpRequest.nextStatus = 200
  restoreWindow()
  restoreXmlHttpRequest()
})

test('uploads the import package with xhr progress and custom headers', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {location: {hash: '', origin: 'http://localhost:3000', search: ''}},
    writable: true,
  })
  Object.defineProperty(globalThis, 'XMLHttpRequest', {configurable: true, value: MockXMLHttpRequest, writable: true})

  MockXMLHttpRequest.nextResponseText = JSON.stringify({data: {id: 'import-session-1'}, error: null})

  const progressUpdates: number[] = []
  const file = new File(['zip-body'], 'project-upload.zip', {type: 'application/zip'})
  const result = await uploadProjectImportPackage({
    file,
    onProgress: (percent) => {
      progressUpdates.push(percent)
    },
    sessionId: 'import-session-1',
  })
  const request = MockXMLHttpRequest.lastInstance

  expect(result).toEqual({id: 'import-session-1'})
  expect(request).not.toBeNull()
  expect(request?.method).toBe('PUT')
  expect(request?.url).toBe('http://127.0.0.1:3001/api/projects/import/import-session-1/upload')
  expect(request?.withCredentials).toBe(true)
  expect(request?.sentBody).toBe(file)
  expect(request?.headers).toEqual({
    'content-type': 'application/zip',
    'x-project-transfer-filename': 'project-upload.zip',
  })
  expect(progressUpdates).toEqual([100, 100])
})
