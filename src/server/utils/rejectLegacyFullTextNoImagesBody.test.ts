import {expect, test} from 'bun:test'
import {Elysia, t} from 'elysia'

import {
  legacyFullTextNoImagesBodyErrorMessage,
  rejectLegacyFullTextNoImagesBody,
} from './rejectLegacyFullTextNoImagesBody.ts'

const app = new Elysia()
  .post(
    '/with-body',
    ({body}) => {
      return {body}
    },
    {body: t.Object({name: t.String()}), transform: rejectLegacyFullTextNoImagesBody},
  )
  .post(
    '/without-body',
    () => {
      return {ok: true}
    },
    {transform: rejectLegacyFullTextNoImagesBody},
  )

const post = async (path: string, body?: unknown) => {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : {'content-type': 'application/json'},
      method: 'POST',
    }),
  )

  return {status: response.status, text: await response.text()}
}

test('a body that sends useFulltextNoImages false is rejected with 400 before validation strips it', async () => {
  const response = await post('/with-body', {name: 'project', useFulltextNoImages: false})

  expect(response).toEqual({status: 400, text: legacyFullTextNoImagesBodyErrorMessage})
})

test('a body that sends useFulltextNoImages true is rejected with 400', async () => {
  const response = await post('/with-body', {name: 'project', useFulltextNoImages: true})

  expect(response).toEqual({status: 400, text: legacyFullTextNoImagesBodyErrorMessage})
})

test('a body that sends useFulltextNoImages null is rejected with 400', async () => {
  const response = await post('/with-body', {name: 'project', useFulltextNoImages: null})

  expect(response.status).toBe(400)
})

test('a body without the field passes through unchanged', async () => {
  const response = await post('/with-body', {name: 'project', useFulltext: true})

  expect(response).toEqual({status: 200, text: JSON.stringify({body: {name: 'project'}})})
})

test('a route without a body schema accepts an empty request and rejects the field when sent', async () => {
  expect(await post('/without-body')).toEqual({status: 200, text: JSON.stringify({ok: true})})
  expect((await post('/without-body', {useFulltextNoImages: false})).status).toBe(400)
})
