import {render} from 'solid-js/web'

import {Router} from './router'

const rootElement = document.getElementById('root')
if (rootElement && !rootElement.innerHTML) {
  render(() => {
    return <Router />
  }, rootElement)
}
