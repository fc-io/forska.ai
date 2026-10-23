import {getCodexAppRuntimeStatus, startCodexAppDeviceLogin} from '../../providers/transports/codexAppTransport.ts'

export const modelsRoutesPostCodexLogin = async () => {
  const status = await getCodexAppRuntimeStatus()
  const cli = status.cli

  if (cli.ok && cli.loggedIn) {
    return {data: {started: false, job: null, message: 'Already logged in.'}, error: null}
  }

  const job = startCodexAppDeviceLogin()

  return {data: {started: true, job, message: 'Started Codex device login.'}, error: null}
}
