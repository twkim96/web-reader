import { sanitizePublicationMarkup } from './publication-sanitizer.js'

// WebKit blocks parent-realm event listeners when allow-scripts is absent
// (WebKit bug 218086). Publication-authored scripts remain blocked by the
// renderer-boundary sanitizer and its script-src 'none' CSP.
export const PUBLICATION_SANDBOX = 'allow-same-origin allow-scripts'

const publicationMediaTypes = new Set([
    'text/html',
    'application/xhtml+xml',
    'image/svg+xml',
])

export const preparePublicationURL = async (src, signal) => {
    if (!src || src === 'about:blank') return { url: src, revoke: () => {} }
    const response = await fetch(src, { signal })
    if (!response.ok) throw new Error(`Failed to prepare publication document: ${response.status}`)
    const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (!publicationMediaTypes.has(mediaType)) {
        throw new Error(`Unsupported publication document type: ${mediaType ?? 'unknown'}`)
    }
    const sanitized = sanitizePublicationMarkup(await response.text(), mediaType)
    const url = URL.createObjectURL(new Blob([sanitized], { type: mediaType }))
    return { url, revoke: () => URL.revokeObjectURL(url) }
}
