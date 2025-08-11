import {createFileRoute} from '@tanstack/solid-router'

import {Login} from '../../../components/login'

export const Route = createFileRoute('/login/')({component: Login})

// TODO: fix the route for the login page, this is looking funky now
