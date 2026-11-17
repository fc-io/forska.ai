import '../index.css'

import {createFileRoute} from '@tanstack/solid-router'

import {ProjectsPage} from './+projects/projectsPage.tsx'

export const Route = createFileRoute('/')({component: ProjectsPage})
