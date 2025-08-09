import {adminClient} from 'better-auth/client/plugins'
import {createAuthClient} from 'better-auth/solid'

export const authClient = createAuthClient({
  /** The base URL of the server (optional if you're using the same domain) */
  baseURL: 'http://localhost:3000',
  plugins: [adminClient()],
})
