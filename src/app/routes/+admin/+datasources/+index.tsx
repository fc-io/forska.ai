import {createFileRoute} from '@tanstack/solid-router'

import {AdminDataSources} from './adminDataSources.tsx'

export const Route = createFileRoute('/admin/datasources/')({component: AdminDataSources})
