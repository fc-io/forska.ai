import {treaty} from '@elysiajs/eden'
// const app = treaty<App>('localhost:3000')
// const {data, error} = await app.get()
// const {data: test, error: testError} = await app.test.get()
// console.log('Hello World – ', 'data:', data, 'test:', test)
import {createAuthClient} from 'better-auth/client'

import type {App} from '../server/index.ts'
export const authClient = createAuthClient({
  /** The base URL of the server (optional if you're using the same domain) */
  baseURL: 'http://localhost:3000',
})

authClient.signUp({email: 'test@test.com', password: 'test'})
