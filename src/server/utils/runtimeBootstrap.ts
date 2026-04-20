import {installSafeConsoleLogging} from './installSafeConsoleLogging.ts'
import {getRuntimeLogConfig, installRuntimeJsonlSink} from './runtimeLogger.ts'
import {initializeRuntimeProcessIdentity, type RuntimeProcessServiceName} from './runtimeProcessIdentity.ts'

export type RuntimeServiceName = RuntimeProcessServiceName

type BootstrapRuntimeOptions = {envValues?: Record<string, string | undefined>; serviceName: RuntimeServiceName}

type ServerRuntimeBootstrapOptions = {envValues?: Record<string, string | undefined>}

const getTrimmedValue = (value: string | null | undefined) => {
  const normalizedValue = String(value ?? '').trim()

  return normalizedValue === '' ? null : normalizedValue
}

const getServerRoleRuntimeServiceName = (serverRole: string | null): RuntimeServiceName => {
  return serverRole === 'api'
    ? 'api-server'
    : serverRole === 'dev-single'
      ? 'dev-single-server'
      : serverRole === 'auto'
        ? 'single-server'
        : 'worker-server'
}

export const getRuntimeServiceNameForServerRole = (
  envValues: Record<string, string | undefined> = process.env,
): RuntimeServiceName => {
  return getServerRoleRuntimeServiceName(getTrimmedValue(envValues.SERVER_ROLE) ?? 'auto')
}

export const bootstrapRuntime = ({
  envValues = process.env,
  serviceName,
}: BootstrapRuntimeOptions): RuntimeServiceName => {
  const runtimeLogConfig = getRuntimeLogConfig({envValues})
  envValues.FORSKA_RUNTIME_SERVICE = serviceName
  envValues.FORSKA_RUNTIME_PROFILE = runtimeLogConfig.runtimeProfile
  envValues.LOG_DIR = runtimeLogConfig.logDir
  envValues.LOG_LEVEL = runtimeLogConfig.logLevel
  envValues.LOG_STDERR_LEVEL = runtimeLogConfig.logStderrLevel
  initializeRuntimeProcessIdentity({envValues, runtimeProfile: runtimeLogConfig.runtimeProfile, service: serviceName})
  installSafeConsoleLogging()
  installRuntimeJsonlSink({envValues})
  return serviceName
}

export const bootstrapAppServerRuntime = (envValues: Record<string, string | undefined> = process.env) => {
  return bootstrapRuntime({envValues, serviceName: 'app-server'})
}

export const bootstrapServerRuntime = ({
  envValues = process.env,
}: ServerRuntimeBootstrapOptions = {}): RuntimeServiceName => {
  return bootstrapRuntime({envValues, serviceName: getRuntimeServiceNameForServerRole(envValues)})
}
