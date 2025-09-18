// import {and, count, eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'

export const judgmentsJobsAdjustBatchSize = async (db: PostgresJsDatabase<typeof schema>) => {
  // check if last period (1min) was faster (more tokens per minute) than the previous period
  // if it was, and the last change was an increase then increase the batch size once more
  // if it was, but the last change was a decrease then decrease the batch size once more
  // if it was not faster, go back to the previous settings
  // if a new batch size is set, save the new batch size to the database
  // before each change (and also if no change has been made) locally store the info about the previous setting: ie total tokens, prompt token,
  // completion token, number of articles (called requets in the token table) and the total send_to_llm_batch_size and
  // send_to_llm_intervalfor allJobs, also indicate if the last change was an increase or a decrease, or no change
}
