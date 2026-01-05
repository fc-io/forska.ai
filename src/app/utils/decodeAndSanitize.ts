import DOMPurify from 'dompurify'

type DecodeAndSanitizeOptions = {convertNewlines?: boolean}

export const decodeAndSanitize = (html: string, options: DecodeAndSanitizeOptions = {}) => {
  const convertNewlines = options.convertNewlines ?? true

  if (typeof document === 'undefined') {
    // Fallback for server-side rendering if needed, though this relies on DOM
    return html
  }
  const textarea = document.createElement('textarea')
  textarea.innerHTML = html

  const decoded = textarea.value
  const withBreaks = convertNewlines ? decoded.replace(/\n/g, '<br>') : decoded

  return DOMPurify.sanitize(withBreaks)
}
