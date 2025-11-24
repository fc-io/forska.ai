import DOMPurify from 'dompurify'

export const decodeAndSanitize = (html: string) => {
  if (typeof document === 'undefined') {
    // Fallback for server-side rendering if needed, though this relies on DOM
    return html
  }
  const textarea = document.createElement('textarea')
  textarea.innerHTML = html
  // Convert newlines to <br> tags before sanitizing
  const withBreaks = textarea.value.replace(/\n/g, '<br>')
  return DOMPurify.sanitize(withBreaks)
}
