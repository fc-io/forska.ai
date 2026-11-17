import {createFileRoute} from '@tanstack/solid-router'

import {AdminDataSourceTrackingChanges} from './adminDataSourceTrackingChanges.tsx'

export const Route = createFileRoute('/admin/datasources/$id/changes')({component: AdminDataSourceTrackingChanges})
