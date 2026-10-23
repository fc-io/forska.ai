import {getAppDatabaseService} from '../../services/appDatabaseService.ts'

export const articlesRoutesPostConversionReset = async () => {
  await getAppDatabaseService().run(`
      UPDATE app.article
      SET full_text_conversion_status = NULL,
          full_text_conversion_attempts = 0,
          full_text_conversion_error = NULL,
          updated_at = current_timestamp
      WHERE full_text_conversion_status = 'failed'
    `)

  return {success: true}
}
