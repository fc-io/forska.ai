import {treaty} from '@elysiajs/eden'

import type {App} from '../server/index.ts'

export const apiClient = treaty<App>(
  import.meta.env.VITE_SERVER_URL || 'http://localhost:3000',
)
