import {createFileRoute} from '@tanstack/solid-router'

import {AdminEditDataSource} from './adminEditDataSource.tsx'

export const Route = createFileRoute('/admin/datasources/$id/edit')({component: AdminEditDataSource})
