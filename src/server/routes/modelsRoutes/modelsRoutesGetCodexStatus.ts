import {getCodexAppRuntimeStatus} from '../../providers/transports/codexAppTransport.ts'

export const modelsRoutesGetCodexStatus = async () => {
  return {data: await getCodexAppRuntimeStatus(), error: null}
}
