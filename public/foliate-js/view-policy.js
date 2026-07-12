const CJK_LANGUAGES = new Set(['zh', 'ja', 'ko'])

export const isCJKLanguage = language => {
    const canonical = Intl.getCanonicalLocales(language)[0]
    return CJK_LANGUAGES.has(new Intl.Locale(canonical).language)
}

export const findContentByIndex = (contents, index) =>
    contents.find(content => content.index === index)
