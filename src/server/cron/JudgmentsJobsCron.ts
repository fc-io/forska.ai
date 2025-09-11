import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

export const judgmentsJobsCron = new Elysia().use(
  cron({
    name: 'judgments-jobs-cron',
    pattern: '*/5 * * * * *',
    run() {
      console.log('cron running!')
    },
  }),
)
