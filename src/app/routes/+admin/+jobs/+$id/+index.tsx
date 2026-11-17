import {createFileRoute} from '@tanstack/solid-router'

import {AdminJudgmentJobDetail} from './adminJudgmentJobDetail.tsx'

export const Route = createFileRoute('/admin/jobs/$id/')({component: AdminJudgmentJobDetail})
