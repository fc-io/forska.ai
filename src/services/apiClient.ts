import {treaty} from '@elysiajs/eden'

import {apiFetch} from '../app/utils/apiFetch.ts'
import {env} from '../app/utils/client-env.ts'
import type {App} from '../server/index.ts'

export const apiClient = treaty<App>(env.VITE_SERVER_API, {fetcher: apiFetch})
