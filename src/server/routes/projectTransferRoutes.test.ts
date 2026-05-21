import {expect, test} from 'bun:test'
import {Elysia} from 'elysia'

import {duckdbOwnerPrivateApiPrefix} from './apiRouteClassification.ts'
import {getProductApiRoutes} from './productApiRoutes.ts'
import {projectTransferRouteSpecs} from './projectTransferRoutes.ts'

type RouteTestApp = {handle: (request: Request) => Promise<Response> | Response}
type PlaceholderResponseBody = {data: null; error: string}

const bodyMethods = new Set(['PATCH', 'POST', 'PUT'])
const csvExportRoute = {method: 'POST', samplePath: '/api/projects/project-1/export'} as const

const getRequestInit = (method: string): RequestInit => {
  return bodyMethods.has(method)
    ? {body: JSON.stringify({}), headers: {'content-type': 'application/json'}, method}
    : {method}
}

const getRouteResponse = async (app: RouteTestApp, path: string, method: string) => {
  return app.handle(new Request(`http://localhost${path}`, getRequestInit(method)))
}

const getPlaceholderBody = async (response: Response) => {
  return (await response.json()) as PlaceholderResponseBody
}

const expectTransferRouteShellResponse = async (app: RouteTestApp, prefix = '') => {
  const responses = await Promise.all(
    projectTransferRouteSpecs.map(async (route) => {
      const response = await getRouteResponse(app, `${prefix}${route.samplePath}`, route.method)
      const body = await getPlaceholderBody(response)

      return {body, endpoint: route.endpoint, status: response.status}
    }),
  )

  expect(
    responses.map((response) => {
      return {endpoint: response.endpoint, error: response.body.error, status: response.status}
    }),
  ).toEqual(
    projectTransferRouteSpecs.map((route) => {
      return {
        endpoint: route.endpoint,
        error: `Project transfer ${route.endpoint} endpoint is not implemented yet`,
        status: 501,
      }
    }),
  )
}

const expectCsvExportRouteValidationResponse = async (app: RouteTestApp, prefix = '') => {
  const response = await getRouteResponse(app, `${prefix}${csvExportRoute.samplePath}`, csvExportRoute.method)
  const body = (await response.json()) as {message: string; property: string; type: string}

  expect(response.status).toBe(422)
  expect(body).toMatchObject({message: 'Expected array', property: '/promptIds', type: 'validation'})
}

test('product route composition mounts project transfer routes before project id routes', async () => {
  await expectTransferRouteShellResponse(getProductApiRoutes())
})

test('owner-private product route composition mounts project transfer routes before project id routes', async () => {
  const app = new Elysia({prefix: duckdbOwnerPrivateApiPrefix}).use(getProductApiRoutes())

  await expectTransferRouteShellResponse(app, duckdbOwnerPrivateApiPrefix)
})

test('existing CSV project export route remains classified separately from project transfer export shell', async () => {
  await expectCsvExportRouteValidationResponse(getProductApiRoutes())
})

test('owner-private existing CSV project export route remains classified separately from transfer shell', async () => {
  const app = new Elysia({prefix: duckdbOwnerPrivateApiPrefix}).use(getProductApiRoutes())

  await expectCsvExportRouteValidationResponse(app, duckdbOwnerPrivateApiPrefix)
})
