const CJK_LANGUAGES = new Set(['zh', 'ja', 'ko'])

// Share the spread threshold between the renderer's container and reader chrome.
export const TWO_PAGE_LAYOUT_QUERY = '(min-aspect-ratio: 1/1)'
export const VERTICAL_TWO_PAGE_LAYOUT_QUERY = '(max-aspect-ratio: 1/1)'

export const isCJKLanguage = language => {
    const canonical = Intl.getCanonicalLocales(language)[0]
    return CJK_LANGUAGES.has(new Intl.Locale(canonical).language)
}

export const findContentByIndex = (contents, index) =>
    contents.find(content => content.index === index)
