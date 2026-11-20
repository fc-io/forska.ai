import {createFileRoute, redirect} from '@tanstack/solid-router'

export const Route = createFileRoute('/projects/$id/reviews/$articleId/')({
  beforeLoad: ({params}) => {
    throw redirect({to: '/projects/$id/reviews-llm/$articleId', params: {id: params.id, articleId: params.articleId}})
  },
})
