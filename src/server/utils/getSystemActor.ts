import {localUserDefaults} from '../../utils/localUser.ts'
import {env} from './env.ts'

const getOpenalexMailto = () => {
  const rawValue = String(env.OPENALEX_MAILTO ?? '').trim()
  return rawValue === '' ? null : rawValue
}

export const getSystemActor = () => {
  return {...localUserDefaults, openalexMailto: getOpenalexMailto()}
}
