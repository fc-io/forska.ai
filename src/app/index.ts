import {treaty} from '@elysiajs/eden'

import type {App} from '../server/index.ts'

const app = treaty<App>('localhost:3000')

const {data, error} = await app.get()
const {data: test, error: testError} = await app.test.get()

console.log('Hello World – ', 'data:', data, 'test:', test)
