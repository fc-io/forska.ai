import {createFileRoute} from '@tanstack/solid-router'

import {ProjectsPage} from './projectsPage.tsx'

export const Route = createFileRoute('/projects/')({component: ProjectsPage})
