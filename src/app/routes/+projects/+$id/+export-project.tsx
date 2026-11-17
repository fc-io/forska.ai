import {createFileRoute} from '@tanstack/solid-router'

import {ExportProject} from './exportProject.tsx'

export const Route = createFileRoute('/projects/$id/export-project')({component: ExportProject})
