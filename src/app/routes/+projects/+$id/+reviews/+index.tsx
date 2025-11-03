import {createFileRoute, useNavigate} from '@tanstack/solid-router'
import {createEffect} from 'solid-js'

const RedirectReviews = () => {
  const params = Route.useParams()
  const navigate = useNavigate()
  createEffect(() => {
    void navigate({to: '/projects/$id/reviews-both', params: {id: params().id}})
  })
  return null
}

export const Route = createFileRoute('/projects/$id/reviews/')({component: RedirectReviews})
