import {createFileRoute, useNavigate} from '@tanstack/solid-router'
import {createEffect} from 'solid-js'

const RedirectReviewArticle = () => {
  const params = Route.useParams() as {id: string; articleId: string}
  const navigate = useNavigate()
  createEffect(() => {
    void navigate({to: '/projects/$id/reviews-llm/$articleId', params: {id: params.id, articleId: params.articleId}})
  })
  return null
}

export const Route = createFileRoute('/projects/$id/reviews/$articleId/')({component: RedirectReviewArticle})
