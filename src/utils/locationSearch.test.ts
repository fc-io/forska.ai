import {describe, expect, test} from 'bun:test'

import {getLocationHrefWithSearch, getLocationSearch} from './locationSearch.ts'

const browserLocation = {hash: '', pathname: '/projects/abc/reviews-llm', protocol: 'http:', search: '?page=2&limit=25'}

const desktopLocation = {
  hash: '#/projects/abc/reviews-llm?page=2&limit=25',
  pathname: '/mainview/index.html',
  protocol: 'views:',
  search: '',
}

describe('getLocationSearch', () => {
  test('reads the window search in browser history mode', () => {
    expect(getLocationSearch(browserLocation)).toBe('?page=2&limit=25')
  })

  test('reads the search from the hash route in hash history mode', () => {
    expect(getLocationSearch(desktopLocation)).toBe('?page=2&limit=25')
  })

  test('ignores the base window search in hash history mode', () => {
    expect(getLocationSearch({...desktopLocation, hash: '#/projects/abc/reviews-llm', search: '?apiOrigin=x'})).toBe('')
  })

  test('returns an empty search when the hash is missing', () => {
    expect(getLocationSearch({...desktopLocation, hash: ''})).toBe('')
  })
})

describe('getLocationHrefWithSearch', () => {
  test('keeps the pathname and replaces the search in browser history mode', () => {
    expect(getLocationHrefWithSearch(browserLocation, 'page=3')).toBe('/projects/abc/reviews-llm?page=3')
    expect(getLocationHrefWithSearch(browserLocation, '')).toBe('/projects/abc/reviews-llm')
  })

  test('keeps the hash route and replaces its search in hash history mode', () => {
    expect(getLocationHrefWithSearch(desktopLocation, 'page=3')).toBe(
      '/mainview/index.html#/projects/abc/reviews-llm?page=3',
    )
    expect(getLocationHrefWithSearch(desktopLocation, '')).toBe('/mainview/index.html#/projects/abc/reviews-llm')
  })

  test('preserves the base window search and nested fragment in hash history mode', () => {
    expect(
      getLocationHrefWithSearch(
        {...desktopLocation, hash: '#/projects/abc/reviews-llm?page=2#section', search: '?apiOrigin=x'},
        'page=3',
      ),
    ).toBe('/mainview/index.html?apiOrigin=x#/projects/abc/reviews-llm?page=3#section')
  })

  test('falls back to the root hash route when the hash is missing', () => {
    expect(getLocationHrefWithSearch({...desktopLocation, hash: ''}, 'page=3')).toBe('/mainview/index.html#/?page=3')
  })

  test('accepts a search that already starts with a question mark', () => {
    expect(getLocationHrefWithSearch(browserLocation, '?page=3')).toBe('/projects/abc/reviews-llm?page=3')
  })
})
