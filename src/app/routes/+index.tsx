import '../index.css'

import {createFileRoute} from '@tanstack/solid-router'

import {ProjectsPage} from './+projects/+index'

export const Route = createFileRoute('/')({component: ProjectsPage})
