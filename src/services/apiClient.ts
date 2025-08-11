import {treaty} from '@elysiajs/eden'

import type {App} from '../server/index.ts'

export const apiClient = treaty<App>('http://localhost:3000')
