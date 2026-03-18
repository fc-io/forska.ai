import {localUserDefaults} from '../../utils/localUser.ts'

export const getSystemActor = () => {
  return localUserDefaults
}
