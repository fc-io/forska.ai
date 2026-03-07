import {localSession, localUserId} from '../utils/localUser'
import {apiClient} from './apiClient.ts'

export const fetchSession = async () => {
  console.log('fetchSession')
  return apiClient.api.users.get().then(
    (response) => {
      if (response.error) {
        console.error('Error fetching session user:', response.error)
        return localSession
      }

      const rows = response.data?.data ?? []
      const candidate =
        rows.find((u) => {
          return u.id === localUserId
        })
        ?? rows[0]
        ?? null

      const resolvedUser = candidate
        ? {
            id: candidate.id,
            name: candidate.name ?? localSession.user.name,
            email: candidate.email ?? localSession.user.email,
            role: candidate.role ?? null,
          }
        : localSession.user

      return {user: resolvedUser, session: {userId: resolvedUser.id}}
    },
    (error) => {
      console.error('Error fetching session:', error)
      return localSession
    },
  )
}
