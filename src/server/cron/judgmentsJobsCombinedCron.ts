import {Elysia} from 'elysia'

import {judgmentsJobsJudgingCron} from './judgmentsJobsJudgingCron.ts'
import {judgmentsJobsOperationalCron} from './judgmentsJobsOperationalCron.ts'

export const judgmentsJobsCron = new Elysia().use(judgmentsJobsOperationalCron).use(judgmentsJobsJudgingCron)
