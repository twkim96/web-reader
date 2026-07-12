const CSP = [
    "default-src 'none'",
    "script-src 'none'",
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "img-src blob: data:",
    "media-src blob: data:",
    "font-src blob: data:",
    "style-src 'unsafe-inline' blob:",
].join('; ')

const blockedElements = new Set([
    'script', 'object', 'embed', 'iframe', 'frame', 'frameset', 'foreignobject',
])
const resourceAttributes = new Set([
    'src', 'poster', 'data', 'background', 'formaction',
])
const safeDataURL = /^data:(?:image\/(?:png|jpe?g|gif|webp|avif)|audio\/|video\/|font\/|application\/font-)/i

const normalizedURL = value => value.trim().replace(/[\u0000-\u0020]+/g, '')

export const isSafePublicationURL = (value, { anchor = false } = {}) => {
    if (!value) return true
    const url = normalizedURL(value)
    if (!url) return true
    if (url.startsWith('#') || /^blob:/i.test(url)) return true
    if (/^data:/i.test(url)) return safeDataURL.test(url)
    if (/^(?:javascript|vbscript|file|filesystem):/i.test(url)) return false
    if (/^(?:https?:)?\/\//i.test(url)) return anchor && /^https?:/i.test(url)
    return !/^\w+:/i.test(url)
}

const readCSSURL = (css, start) => {
    let index = start
    while (/\s/.test(css[index] ?? '')) index++
    const quote = css[index] === '"' || css[index] === "'" ? css[index++] : null
    let value = ''
    while (index < css.length) {
        const char = css[index++]
        if (char === '\\' && index < css.length) {
            value += css[index++]
            continue
        }
        if (quote ? char === quote : char === ')') break
        value += char
    }
    return value.trim()
}

export const hasUnsafeCSS = css => {
    const normalizedCSS = css
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\\([0-9a-f]{1,6})\s?/gi, (_match, hex) => {
            const codePoint = Number.parseInt(hex, 16)
            return codePoint === 0 || codePoint > 0x10ffff ? '\uFFFD' : String.fromCodePoint(codePoint)
        })
        .replace(/\\([^\n\r\f0-9a-f])/gi, '$1')
    let index = 0
    let quote = null
    let comment = false
    const lower = normalizedCSS.toLowerCase()
    if (/(?:image-set|expression|-moz-binding)\s*\(/i.test(lower)) return true
    while (index < normalizedCSS.length) {
        if (comment) {
            if (normalizedCSS[index] === '*' && normalizedCSS[index + 1] === '/') {
                comment = false
                index += 2
            } else index++
            continue
        }
        if (quote) {
            if (normalizedCSS[index] === '\\') index += 2
            else if (normalizedCSS[index++] === quote) quote = null
            continue
        }
        if (normalizedCSS[index] === '/' && normalizedCSS[index + 1] === '*') {
            comment = true
            index += 2
            continue
        }
        if (normalizedCSS[index] === '"' || normalizedCSS[index] === "'") {
            quote = normalizedCSS[index++]
            continue
        }
        if (lower.startsWith('@import', index)) return true
        if (lower.startsWith('url(', index)) {
            const value = readCSSURL(normalizedCSS, index + 4)
            if (!isSafePublicationURL(value)) return true
        }
        index++
    }
    return false
}

const sanitizeStyleDeclaration = style => {
    if (!style) return
    for (const property of Array.from(style)) {
        if (hasUnsafeCSS(style.getPropertyValue(property))) style.removeProperty(property)
    }
}

const sanitizeStyleElement = element => {
    const css = element.textContent ?? ''
    // CSSOM provides the parser boundary in browsers. Detached/XML documents may
    // not expose a sheet, so the same token scanner remains the conservative gate.
    const sheet = element.sheet
    if (sheet?.cssRules) {
        const safe = []
        for (const rule of Array.from(sheet.cssRules)) {
            if (rule.type === 3 || hasUnsafeCSS(rule.cssText)) continue
            sanitizeStyleDeclaration(rule.style)
            if (!hasUnsafeCSS(rule.cssText)) safe.push(rule.cssText)
        }
        if (safe.length === 0) element.remove()
        else element.textContent = safe.join('\n')
    } else if (hasUnsafeCSS(css)) element.remove()
}

const ensureCSP = doc => {
    const root = doc.documentElement
    if (!root) return
    let head = doc.querySelector('head')
    if (!head) {
        head = doc.createElementNS(root.namespaceURI, 'head')
        root.insertBefore(head, root.firstChild)
    }
    for (const meta of Array.from(doc.querySelectorAll('meta[http-equiv]'))) {
        const directive = meta.getAttribute('http-equiv')?.toLowerCase()
        if (directive === 'refresh' || directive === 'content-security-policy') meta.remove()
    }
    const meta = doc.createElementNS(root.namespaceURI, 'meta')
    meta.setAttribute('http-equiv', 'Content-Security-Policy')
    meta.setAttribute('content', CSP)
    head.prepend(meta)
}

export const sanitizePublicationDocument = doc => {
    if (!doc?.documentElement) return doc
    for (const element of Array.from(doc.querySelectorAll('*'))) {
        const name = element.localName?.toLowerCase()
        if (blockedElements.has(name)) {
            element.remove()
            continue
        }
        if (name === 'meta' && element.getAttribute('http-equiv')?.toLowerCase() === 'refresh') {
            element.remove()
            continue
        }
        if (name === 'base') {
            element.remove()
            continue
        }
        for (const attribute of Array.from(element.attributes)) {
            const attrName = attribute.localName.toLowerCase()
            if (attrName.startsWith('on') || attrName === 'srcdoc') {
                element.removeAttributeNode(attribute)
                continue
            }
            if (attrName === 'style') {
                sanitizeStyleDeclaration(element.style)
                if (hasUnsafeCSS(element.getAttribute(attribute.name) ?? '')) {
                    element.removeAttributeNode(attribute)
                }
                continue
            }
            if (attrName === 'srcset') {
                const candidates = attribute.value.split(',').map(value => value.trim())
                if (candidates.some(candidate => !isSafePublicationURL(candidate.split(/\s+/)[0]))) {
                    element.removeAttributeNode(attribute)
                }
                continue
            }
            if (attrName === 'href') {
                const isAnchor = name === 'a' || name === 'area'
                if (!isSafePublicationURL(attribute.value, { anchor: isAnchor })) {
                    element.removeAttributeNode(attribute)
                } else if (isAnchor && /^https?:/i.test(normalizedURL(attribute.value))) {
                    element.setAttribute('target', '_blank')
                    element.setAttribute('rel', 'noopener noreferrer')
                }
                continue
            }
            if (resourceAttributes.has(attrName) && !isSafePublicationURL(attribute.value)) {
                element.removeAttributeNode(attribute)
            }
        }
        if (name === 'form') {
            element.removeAttribute('action')
            element.setAttribute('onsubmit', 'return false')
            element.removeAttribute('onsubmit')
        }
        if (name === 'style') sanitizeStyleElement(element)
        if (name === 'link' && element.getAttribute('rel')?.toLowerCase() === 'stylesheet'
            && !isSafePublicationURL(element.getAttribute('href') ?? '')) element.remove()
    }
    for (const child of Array.from(doc.childNodes)) {
        if (child.nodeType === 7) child.remove()
    }
    ensureCSP(doc)
    return doc
}

export const sanitizePublicationMarkup = (markup, mediaType) => {
    const doc = new DOMParser().parseFromString(markup, mediaType)
    sanitizePublicationDocument(doc)
    return new XMLSerializer().serializeToString(doc)
}

export { CSP as PUBLICATION_CSP }
