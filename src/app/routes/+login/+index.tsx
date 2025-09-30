import {createFileRoute} from '@tanstack/solid-router'

import {Login} from '../../../components/login'

export const Route = createFileRoute('/login/')({component: Login})
