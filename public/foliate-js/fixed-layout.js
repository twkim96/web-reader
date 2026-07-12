import { LatestTask, createAbortError, isAbortError } from './latest-task.js'
import { preparePublicationURL, PUBLICATION_SANDBOX } from './sandbox-policy.js'

const parseViewport = str => str
    ?.split(/[,;\s]/) // NOTE: technically, only the comma is valid
    ?.filter(x => x)
    ?.map(x => x.split('=').map(x => x.trim()))

const getViewport = (doc, viewport) => {
    // use `viewBox` for SVG
    if (doc.documentElement.localName === 'svg') {
        const [, , width, height] = doc.documentElement
            .getAttribute('viewBox')?.split(/\s/) ?? []
        return { width, height }
    }

    // get `viewport` `meta` element
    const meta = parseViewport(doc.querySelector('meta[name="viewport"]')
        ?.getAttribute('content'))
    if (meta) return Object.fromEntries(meta)

    // fallback to book's viewport
    if (typeof viewport === 'string') return parseViewport(viewport)
    if (viewport?.width && viewport.height) return viewport

    // if no viewport (possibly with image directly in spine), get image size
    const img = doc.querySelector('img')
    if (img) return { width: img.naturalWidth, height: img.naturalHeight }

    // just show *something*, i guess...
    console.warn(new Error('Missing viewport properties'))
    return { width: 1000, height: 2000 }
}

export class FixedLayout extends HTMLElement {
    static observedAttributes = ['zoom']
    static minUserScale = 1
    static maxUserScale = 4
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => this.#render())
    #spreads
    #index = -1
    #targetIndex = -1
    #navigation = new LatestTask()
    defaultViewport
    spread
    #portrait = false
    #left
    #right
    #center
    #side
    #zoom
    #userScale = 1
    #lastBaseScale = 1
    #lastScale = 1
    constructor() {
        super()

        const sheet = new CSSStyleSheet()
        this.#root.adoptedStyleSheets = [sheet]
        sheet.replaceSync(`:host {
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
            overflow: auto;
            overscroll-behavior: contain;
            -webkit-overflow-scrolling: touch;
        }`)

        this.#observer.observe(this)
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'zoom':
                this.#zoom = value !== 'fit-width' && value !== 'fit-page'
                    ? parseFloat(value) : value
                this.#render()
                break
        }
    }
    async #createFrame({ index, src: srcOption }, container, signal) {
        const srcOptionIsString = typeof srcOption === 'string'
        const src = srcOptionIsString ? srcOption : srcOption?.src
        const onZoom = srcOptionIsString ? null : srcOption?.onZoom
        const element = document.createElement('div')
        element.setAttribute('dir', 'ltr')
        const iframe = document.createElement('iframe')
        element.append(iframe)
        Object.assign(iframe.style, {
            border: '0',
            display: 'none',
            overflow: 'hidden',
        })
        iframe.setAttribute('sandbox', PUBLICATION_SANDBOX)
        iframe.setAttribute('scrolling', 'no')
        iframe.setAttribute('part', 'filter')
        if (!src) {
            container.append(element)
            return { blank: true, element, iframe, index }
        }
        const publicationURL = await preparePublicationURL(src, signal)
        return new Promise((resolve, reject) => {
            const abort = () => {
                iframe.removeEventListener('load', handleLoad)
                element.remove()
                publicationURL.revoke()
                reject(createAbortError())
            }
            const handleLoad = () => {
                const doc = iframe.contentDocument
                if (!doc || doc.URL === 'about:blank' && src !== 'about:blank') return
                iframe.removeEventListener('load', handleLoad)
                signal.removeEventListener('abort', abort)
                if (signal.aborted) {
                    abort()
                    return
                }
                this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
                const { width, height } = getViewport(doc, this.defaultViewport)
                resolve({
                    element, iframe, index,
                    width: parseFloat(width),
                    height: parseFloat(height),
                    onZoom,
                    revokePublicationURL: publicationURL.revoke,
                })
            }
            signal.addEventListener('abort', abort, { once: true })
            iframe.addEventListener('load', handleLoad)
            iframe.src = publicationURL.url
            container.append(element)
        })
    }
    #render(side = this.#side, { previewZoom = false } = {}) {
        if (!side) return
        const left = this.#left ?? {}
        const right = this.#center ?? this.#right ?? {}
        const target = side === 'left' ? left : right
        const { width, height } = this.getBoundingClientRect()
        const portrait = this.spread !== 'both' && this.spread !== 'portrait'
            && height > width
        this.#portrait = portrait
        const blankWidth = left.width ?? right.width ?? 0
        const blankHeight = left.height ?? right.height ?? 0

        const baseScale = typeof this.#zoom === 'number' && !isNaN(this.#zoom)
            ? this.#zoom
            : (this.#zoom === 'fit-width'
                ? (portrait || this.#center
                    ? width / (target.width ?? blankWidth)
                    : width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)))
                : (portrait || this.#center
                    ? Math.min(
                        width / (target.width ?? blankWidth),
                        height / (target.height ?? blankHeight))
                    : Math.min(
                        width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)),
                        height / Math.max(
                            left.height ?? blankHeight,
                            right.height ?? blankHeight)))
            ) || 1
        const scale = baseScale * this.#userScale
        this.#lastBaseScale = baseScale
        this.#lastScale = scale
        const isUserZoomed = this.#userScale > this.constructor.minUserScale
        const getFrameWidth = frame => frame.width ?? blankWidth
        const getFrameHeight = frame => frame.height ?? blankHeight
        const contentWidth = (portrait || this.#center
            ? getFrameWidth(target)
            : getFrameWidth(left) + getFrameWidth(right)) * scale
        const contentHeight = (portrait || this.#center
            ? getFrameHeight(target)
            : Math.max(getFrameHeight(left), getFrameHeight(right))) * scale
        const overflowsX = isUserZoomed && contentWidth > width + 0.5
        const overflowsY = isUserZoomed && contentHeight > height + 0.5
        Object.assign(this.style, {
            justifyContent: overflowsX ? 'flex-start' : 'center',
            alignItems: overflowsY ? 'flex-start' : 'center',
        })

        const transform = frame => {
            let { element, iframe, width, height, blank, onZoom } = frame
            if (!iframe) return
            if (onZoom) Promise.resolve(onZoom({
                doc: frame.iframe.contentDocument,
                preview: previewZoom,
                scale,
            })).catch(error => {
                if (isAbortError(error)) return
                this.dispatchEvent(new CustomEvent('error', {
                    detail: { error, index: frame.index },
                }))
            })
            const iframeScale = onZoom ? scale : 1
            Object.assign(iframe.style, {
                width: `${width * iframeScale}px`,
                height: `${height * iframeScale}px`,
                transform: onZoom ? 'none' : `scale(${scale})`,
                transformOrigin: 'top left',
                display: blank ? 'none' : 'block',
                backfaceVisibility: 'hidden',
                willChange: onZoom ? 'width, height' : 'transform',
            })
            Object.assign(element.style, {
                width: `${(width ?? blankWidth) * scale}px`,
                height: `${(height ?? blankHeight) * scale}px`,
                overflow: 'hidden',
                display: 'block',
                flexShrink: '0',
                marginBlock: isUserZoomed ? '0' : 'auto',
                willChange: 'width, height',
            })
            if (portrait && frame !== target) {
                element.style.display = 'none'
            }
        }
        if (this.#center) {
            transform(this.#center)
        } else {
            transform(left)
            transform(right)
        }
    }
    #cleanupFrame(frame) {
        if (!frame) return
        frame.onZoom?.cleanup?.(frame.iframe?.contentDocument)
        frame.revokePublicationURL?.()
        frame.element?.remove()
    }
    #cleanupCurrentSpread() {
        this.#cleanupFrame(this.#left)
        this.#cleanupFrame(this.#right)
        this.#cleanupFrame(this.#center)
    }
    #getVisibleFrames() {
        const frames = this.#center ? [this.#center] : [this.#left, this.#right]
        return frames.filter(frame =>
            frame?.element
            && !frame.blank
            && frame.element.style.display !== 'none')
    }
    #getContentOffset() {
        const rect = this.getBoundingClientRect()
        const frames = this.#getVisibleFrames()
        const boxes = frames.map(frame => frame.element.getBoundingClientRect())
        const left = Math.min(...boxes.map(box => box.left))
        const top = Math.min(...boxes.map(box => box.top))
        return {
            x: Number.isFinite(left) ? left - rect.left : 0,
            y: Number.isFinite(top) ? top - rect.top : 0,
        }
    }
    #getPageTurnViewState() {
        if (this.#userScale <= this.constructor.minUserScale) return null
        const maxScrollLeft = Math.max(0, this.scrollWidth - this.clientWidth)
        const maxScrollTop = Math.max(0, this.scrollHeight - this.clientHeight)
        return {
            userScale: this.#userScale,
            scrollLeftRatio: maxScrollLeft > 0 ? this.scrollLeft / maxScrollLeft : 0,
            scrollTopRatio: maxScrollTop > 0 ? this.scrollTop / maxScrollTop : 0,
        }
    }
    #applyPageTurnViewState(viewState) {
        this.#userScale = viewState?.userScale ?? 1
        this.#render()
        if (!viewState) {
            this.scrollLeft = 0
            this.scrollTop = 0
            return
        }
        const maxScrollLeft = Math.max(0, this.scrollWidth - this.clientWidth)
        const maxScrollTop = Math.max(0, this.scrollHeight - this.clientHeight)
        this.scrollLeft = Math.max(0, maxScrollLeft * viewState.scrollLeftRatio)
        this.scrollTop = Math.max(0, maxScrollTop * viewState.scrollTopRatio)
    }
    async #loadSpread({ left, right, center, side }, signal) {
        const staging = document.createElement('div')
        staging.style.display = 'none'
        this.#root.append(staging)
        try {
            if (center) {
                const centerFrame = await this.#createFrame(center, staging, signal)
                return {
                    staging,
                    left: null,
                    right: null,
                    center: centerFrame,
                    side: 'center',
                }
            }
            const [leftFrame, rightFrame] = await Promise.all([
                this.#createFrame(left, staging, signal),
                this.#createFrame(right, staging, signal),
            ])
            return {
                staging,
                left: leftFrame,
                right: rightFrame,
                center: null,
                side: leftFrame.blank ? 'right'
                    : rightFrame.blank ? 'left' : side,
            }
        } catch (error) {
            staging.remove()
            throw error
        }
    }
    #showSpread({ staging, left, right, center, side }, viewState) {
        this.#cleanupCurrentSpread()
        for (const child of [...this.#root.children]) {
            if (child !== staging) child.remove()
        }
        staging.style.display = 'contents'
        this.#left = left
        this.#right = right
        this.#center = center
        this.#side = side
        this.#applyPageTurnViewState(viewState)
    }
    #goLeft() {
        if (this.#center || this.#left?.blank) return
        if (this.#portrait && this.#left?.element?.style?.display === 'none') {
            const viewState = this.#getPageTurnViewState()
            this.#side = 'left'
            this.#applyPageTurnViewState(viewState)
            this.#reportLocation('page')
            return true
        }
    }
    #goRight() {
        if (this.#center || this.#right?.blank) return
        if (this.#portrait && this.#right?.element?.style?.display === 'none') {
            const viewState = this.#getPageTurnViewState()
            this.#side = 'right'
            this.#applyPageTurnViewState(viewState)
            this.#reportLocation('page')
            return true
        }
    }
    open(book) {
        this.#navigation.cancel()
        this.book = book
        this.#index = -1
        this.#targetIndex = -1
        const { rendition } = book
        this.spread = rendition?.spread
        this.defaultViewport = rendition?.viewport

        const rtl = book.dir === 'rtl'
        const ltr = !rtl
        this.rtl = rtl

        if (rendition?.spread === 'none')
            this.#spreads = book.sections.map(section => ({ center: section }))
        else this.#spreads = book.sections.reduce((arr, section, i) => {
            const last = arr[arr.length - 1]
            const { pageSpread } = section
            const newSpread = () => {
                const spread = {}
                arr.push(spread)
                return spread
            }
            if (pageSpread === 'center') {
                const spread = last.left || last.right ? newSpread() : last
                spread.center = section
            }
            else if (pageSpread === 'left') {
                const spread = last.center || last.left || ltr && i ? newSpread() : last
                spread.left = section
            }
            else if (pageSpread === 'right') {
                const spread = last.center || last.right || rtl && i ? newSpread() : last
                spread.right = section
            }
            else if (ltr) {
                if (last.center || last.right) newSpread().left = section
                else if (last.left || !i) last.right = section
                else last.left = section
            }
            else {
                if (last.center || last.left) newSpread().right = section
                else if (last.right || !i) last.left = section
                else last.right = section
            }
            return arr
        }, [{}])
    }
    get index() {
        const spread = this.#spreads[this.#index]
        const section = spread?.center ?? (this.#side === 'left'
            ? spread.left ?? spread.right : spread.right ?? spread.left)
        return this.book.sections.indexOf(section)
    }
    #reportLocation(reason) {
        this.dispatchEvent(new CustomEvent('relocate', { detail:
            { reason, range: null, index: this.index, fraction: 0, size: 1 } }))
    }
    getSpreadOf(section) {
        const spreads = this.#spreads
        for (let index = 0; index < spreads.length; index++) {
            const { left, right, center } = spreads[index]
            if (left === section) return { index, side: 'left' }
            if (right === section) return { index, side: 'right' }
            if (center === section) return { index, side: 'center' }
        }
    }
    async goToSpread(index, side, reason) {
        if (index < 0 || index > this.#spreads.length - 1) return
        const task = this.#navigation.begin()
        const viewState = reason === 'page' ? this.#getPageTurnViewState() : null
        this.#targetIndex = index
        if (index === this.#index) {
            if (side && side !== this.#side) {
                this.#side = side
            }
            this.#applyPageTurnViewState(viewState)
            this.#navigation.finish(task)
            return
        }
        try {
            const spread = this.#spreads[index]
            let loadedSpread
            if (spread.center) {
                const sectionIndex = this.book.sections.indexOf(spread.center)
                const src = await spread.center?.load?.(task.signal)
                if (!this.#navigation.isCurrent(task)) throw createAbortError()
                loadedSpread = await this.#loadSpread({
                    center: { index: sectionIndex, src },
                }, task.signal)
            } else {
                const indexL = this.book.sections.indexOf(spread.left)
                const indexR = this.book.sections.indexOf(spread.right)
                const [srcL, srcR] = await Promise.all([
                    spread.left?.load?.(task.signal),
                    spread.right?.load?.(task.signal),
                ])
                if (!this.#navigation.isCurrent(task)) throw createAbortError()
                loadedSpread = await this.#loadSpread({
                    left: { index: indexL, src: srcL },
                    right: { index: indexR, src: srcR },
                    side,
                }, task.signal)
            }
            if (!this.#navigation.isCurrent(task)) {
                loadedSpread.staging.remove()
                throw createAbortError()
            }
            this.#showSpread(loadedSpread, viewState)
            this.#index = index
            this.#reportLocation(reason)
            this.#navigation.finish(task)
        } catch (error) {
            if (this.#navigation.isCurrent(task)) {
                this.#targetIndex = this.#index
                this.#navigation.finish(task)
            }
            if (!isAbortError(error)) throw error
        }
    }
    async select(target) {
        await this.goTo(target)
        // TODO
    }
    async goTo(target) {
        const { book } = this
        const resolved = await target
        const section = book.sections[resolved.index]
        if (!section) return
        const { index, side } = this.getSpreadOf(section)
        await this.goToSpread(index, side)
    }
    async next() {
        const s = this.rtl ? this.#goLeft() : this.#goRight()
        if (!s) return this.goToSpread(
            this.#targetIndex + 1,
            this.rtl ? 'right' : 'left',
            'page',
        )
    }
    async prev() {
        const s = this.rtl ? this.#goRight() : this.#goLeft()
        if (!s) return this.goToSpread(
            this.#targetIndex - 1,
            this.rtl ? 'left' : 'right',
            'page',
        )
    }
    get userScale() {
        return this.#userScale
    }
    get baseScale() {
        return this.#lastBaseScale
    }
    get effectiveScale() {
        return this.#lastScale
    }
    setUserScale(value, focalPoint, { preview = false } = {}) {
        const minScale = this.constructor.minUserScale
        const maxScale = this.constructor.maxUserScale
        const nextUserScale = Math.min(maxScale, Math.max(minScale, Number(value) || 1))
        if (nextUserScale === this.#userScale) return this.#userScale

        const rect = this.getBoundingClientRect()
        const focalX = Number.isFinite(focalPoint?.x)
            ? focalPoint.x - rect.left
            : rect.width / 2
        const focalY = Number.isFinite(focalPoint?.y)
            ? focalPoint.y - rect.top
            : rect.height / 2
        const previousScale = this.#lastScale || 1
        const contentOffset = this.#getContentOffset()
        const contentX = (focalX - contentOffset.x) / previousScale
        const contentY = (focalY - contentOffset.y) / previousScale

        this.#userScale = nextUserScale
        this.#render(this.#side, { previewZoom: preview })

        const nextScale = this.#lastScale || previousScale
        this.scrollLeft = Math.max(0, contentX * nextScale - focalX)
        this.scrollTop = Math.max(0, contentY * nextScale - focalY)
        return this.#userScale
    }
    adjustUserScale(factor, focalPoint) {
        return this.setUserScale(this.#userScale * (Number(factor) || 1), focalPoint)
    }
    commitUserScale() {
        this.#render()
        return this.#userScale
    }
    panBy(deltaX = 0, deltaY = 0) {
        if (this.#userScale <= this.constructor.minUserScale) {
            return { scrollLeft: this.scrollLeft, scrollTop: this.scrollTop }
        }
        this.scrollLeft = Math.max(0, this.scrollLeft + (Number(deltaX) || 0))
        this.scrollTop = Math.max(0, this.scrollTop + (Number(deltaY) || 0))
        return { scrollLeft: this.scrollLeft, scrollTop: this.scrollTop }
    }
    resetUserScale() {
        this.#userScale = 1
        this.#render()
        this.scrollLeft = 0
        this.scrollTop = 0
        return this.#userScale
    }
    getContents() {
        return this.#getVisibleFrames().map(frame => ({
            doc: frame.iframe.contentDocument,
            index: frame.index,
        }))
    }
    destroy() {
        this.#navigation.cancel()
        this.#observer.unobserve(this)
        this.#cleanupCurrentSpread()
        this.#root.replaceChildren()
    }
}

if (!customElements.get('foliate-fxl')) {
    customElements.define('foliate-fxl', FixedLayout)
}
