import type {Accessor} from 'solid-js'
import {createMemo} from 'solid-js'

/**
 * `createMemo` for list values whose committed value starts as an empty list instead of `undefined`.
 *
 * Route components render inside the router's navigation transition. A memo created there keeps its computed value
 * in transition state until the transition commits. When something re-renders outside that transition before the
 * commit (for example the project query landing while another query still suspends), reads of the memo return its
 * initial value, which for a plain `createMemo` is `undefined`. Starting from an empty list keeps render-time
 * `.length`, `.map` and `<For>` reads safe; the memo recomputes normally once its sources change.
 */
export const createListMemo = <T>(compute: () => T[]): Accessor<T[]> => {
  const list = createMemo<T[]>(compute, [])
  return list
}
