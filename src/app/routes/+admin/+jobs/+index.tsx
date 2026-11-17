import {createFileRoute} from '@tanstack/solid-router'

import {AdminJobs} from './adminJobs.tsx'

export const Route = createFileRoute('/admin/jobs/')({component: AdminJobs})
