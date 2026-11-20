import {createFileRoute, redirect} from '@tanstack/solid-router'

export const Route = createFileRoute('/projects/$id/reviews/')({
  beforeLoad: ({params}) => {
    throw redirect({to: '/projects/$id/reviews-llm', params: {id: params.id}})
  },
})
