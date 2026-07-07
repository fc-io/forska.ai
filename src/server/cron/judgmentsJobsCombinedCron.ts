import {Elysia} from 'elysia'

import {judgmentsJobsMaintenanceCron} from './judgmentsJobs.ts'
import {judgmentsJobsJudgingCron} from './judgmentsJobsJudgingCron.ts'

export const judgmentsJobsCron = new Elysia().use(judgmentsJobsMaintenanceCron).use(judgmentsJobsJudgingCron)
