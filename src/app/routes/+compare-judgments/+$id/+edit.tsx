import {createFileRoute} from '@tanstack/solid-router'

import {EditComparisonProjectPage} from './editComparisonProjectPage.tsx'

export const Route = createFileRoute('/compare-judgments/$id/edit')({component: EditComparisonProjectPage})
