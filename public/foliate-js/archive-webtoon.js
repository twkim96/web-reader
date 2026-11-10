import { createAbortError, isAbortError } from './latest-task.js'
import { PUBLICATION_SANDBOX } from './sandbox-policy.js'

const abortable = (promise, signal) => new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(createAbortError()) }
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
})

// Only encoded image sources and blocks in the ±5 window are retained.
// Decoded images cover the viewport
// plus one neighboring image on either side.
export class ArchiveWebtoon {
    index = -1
    #host
    #book
    #frame
    #doc
    #url
    #slots = new Map()
    #ratios
    #offsets = []
    #start = 0
    #end = 0
    #width = 0
    #scale = 1
    #loading = 0
    #destroyed = false
    #generation = 0
    #navigating = false
    #navigation
    #lastTop = 0
    #geometryDirty = true
    #locked = false
    #onIndex
    #onLoad
    #loaded = false
    #onError
    #onScale
    #gestureCleanup
    #ready
    #stopReady
    #before
    #pages
    #after
    constructor(host, root, book, { onIndex, onLoad, onError, onScale }) {
        this.#host = host
        this.#book = book
        this.#onIndex = onIndex
        this.#onLoad = onLoad
        this.#onError = onError
        this.#onScale = onScale
        this.#ratios = Array(book.sections.length).fill(2)
        const frame = this.#frame = document.createElement('iframe')
        frame.setAttribute('sandbox', PUBLICATION_SANDBOX)
        frame.setAttribute('scrolling', 'yes')
        frame.setAttribute('part', 'filter')
        frame.style.cssText = 'display:block;border:0;width:100%;height:100%'
        this.#ready = new Promise(resolve => {
            this.#stopReady = () => resolve(false)
            frame.addEventListener('load', () => {
                if (this.#destroyed || !frame.contentDocument?.body) return resolve(false)
                this.#doc = frame.contentDocument
                this.#before = this.#doc.querySelector('#before')
                this.#pages = this.#doc.querySelector('#pages')
                this.#after = this.#doc.querySelector('#after')
                this.#doc.documentElement.style.overflow = this.#locked ? 'hidden' : 'auto'
                this.#doc.addEventListener('scroll', this.#onScroll, { passive: true })
                this.#bindGestures()
                resolve(true)
            }, { once: true })
        })
        this.#url = URL.createObjectURL(new Blob([`<!doctype html><html data-archive-webtoon="true"><meta charset="utf-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'unsafe-inline'">
            <style>html{height:100%;overflow:auto;overscroll-behavior:contain;touch-action:pan-x pan-y;-webkit-overflow-scrolling:touch;overflow-anchor:none}html,body{margin:0;padding:0;background:transparent}body{min-height:100%;user-select:none}
            #pages>div{margin:0;padding:0;overflow:hidden}img{display:block;width:100%;height:100%;object-fit:contain}</style>
            <div id="before"></div><div id="pages"></div><div id="after"></div>`], { type: 'text/html' }))
        frame.src = this.#url
        root.append(frame)
        Object.assign(host.style, { display: 'block', overflow: 'hidden', overflowAnchor: 'none' })
    }
    #bindGestures() {
        const doc = this.#doc
        let start = null, pinch = null, drag = null, moved = false
        const metrics = touches => touches.length === 2 ? {
            distance: Math.hypot(touches[1].clientX - touches[0].clientX, touches[1].clientY - touches[0].clientY),
            x: (touches[0].clientX + touches[1].clientX) / 2,
            y: (touches[0].clientY + touches[1].clientY) / 2,
        } : null
        const touchStart = event => {
            if (event.touches.length === 1) {
                moved = false
                start = { x: event.touches[0].clientX, y: event.touches[0].clientY }
            }
            const point = metrics(event.touches)
            if (!point) return
            pinch = { distance: point.distance, scale: this.#scale }
            moved = true
            // A blocking listener is needed only during an explicit pinch;
            // ordinary one-finger scrolling keeps passive listeners throughout.
            doc.addEventListener('touchmove', pinchMove, { passive: false })
        }
        const touchMove = event => {
            const touch = event.touches[0]
            if (start && touch && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 6) moved = true
        }
        const pinchMove = event => {
            const point = metrics(event.touches)
            if (!pinch || !point || pinch.distance <= 0) return
            event.preventDefault()
            this.#onScale?.(pinch.scale * point.distance / pinch.distance, { x: point.x, y: point.y })
        }
        const touchEnd = event => {
            if (event.touches.length < 2) {
                pinch = null
                doc.removeEventListener('touchmove', pinchMove)
            }
            if (!event.touches.length) start = null
        }
        const wheelZoom = event => {
            if (!event.ctrlKey) return
            event.preventDefault()
            this.#onScale?.(this.#scale * Math.exp(-event.deltaY / 200), { x: event.clientX, y: event.clientY })
        }
        const pointerDown = event => {
            if (event.pointerType !== 'mouse' || event.button !== 0) return
            moved = false
            const zoom = /Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey
            if (!zoom && this.#scale <= 1) return
            event.preventDefault()
            drag = { zoom, id: event.pointerId, x: event.clientX, y: event.clientY, startY: event.clientY, scale: this.#scale, target: event.target }
            event.target.setPointerCapture?.(event.pointerId)
        }
        const pointerMove = event => {
            if (!drag || drag.id !== event.pointerId) return
            if (!(event.buttons & 1)) { drag = null; return }
            if (!moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return
            moved = true
            event.preventDefault()
            if (drag.zoom) this.#onScale?.(drag.scale * Math.exp((drag.startY - event.clientY) / 240))
            else {
                doc.dispatchEvent(new Event('webtoon-user-input'))
                this.scrollLeft += drag.x - event.clientX
                this.scroll(drag.y - event.clientY)
                drag.x = event.clientX
                drag.y = event.clientY
            }
        }
        const pointerEnd = () => { drag = null }
        const click = event => {
            if (!moved) return
            moved = false
            event.preventDefault()
            event.stopImmediatePropagation()
        }
        const listeners = [
            ['touchstart', touchStart, { passive: true }], ['touchmove', touchMove, { passive: true }],
            ['touchend', touchEnd, { passive: true }], ['touchcancel', touchEnd, { passive: true }],
            ['wheel', wheelZoom, { passive: false }], ['pointerdown', pointerDown],
            ['pointermove', pointerMove], ['pointerup', pointerEnd], ['pointercancel', pointerEnd],
            ['click', click, true],
        ]
        for (const [name, handler, options] of listeners) doc.addEventListener(name, handler, options)
        this.#gestureCleanup = () => {
            for (const [name, handler, options] of listeners) doc.removeEventListener(name, handler, options)
            doc.removeEventListener('touchmove', pinchMove)
        }
    }
    setLocked(locked) {
        this.#locked = locked
        if (this.#doc) this.#doc.documentElement.style.overflow = locked ? 'hidden' : 'auto'
    }
    get doc() { return this.#doc }
    get scrollTop() { return this.#doc?.scrollingElement?.scrollTop ?? 0 }
    set scrollTop(value) { if (this.#doc?.scrollingElement) this.#doc.scrollingElement.scrollTop = value }
    get scrollLeft() { return this.#doc?.scrollingElement?.scrollLeft ?? 0 }
    set scrollLeft(value) { if (this.#doc?.scrollingElement) this.#doc.scrollingElement.scrollLeft = value }
    get scrollHeight() { return this.#doc?.scrollingElement?.scrollHeight ?? 0 }
    get scrollWidth() { return this.#doc?.scrollingElement?.scrollWidth ?? 0 }
    get #viewportWidth() { return this.#doc?.documentElement.clientWidth || this.#host.clientWidth }
    get #viewportHeight() { return this.#doc?.documentElement.clientHeight || this.#host.clientHeight }
    #anchor() {
        const top = this.scrollTop
        const index = this.#locate(top)
        const height = (this.#offsets[index + 1] ?? 0) - (this.#offsets[index] ?? 0)
        return { index, fraction: height > 0 ? (top - this.#offsets[index]) / height : 0 }
    }
    #locate(top) {
        let low = 0, high = this.#ratios.length - 1
        while (low < high) {
            const middle = Math.floor((low + high) / 2)
            if (this.#offsets[middle + 1] <= top + 0.5) low = middle + 1
            else high = middle
        }
        return low
    }
    #layout(anchor = this.#anchor()) {
        if (!this.#doc || this.#destroyed) return
        const width = Math.max(1, this.#viewportWidth) * this.#scale
        if (this.#geometryDirty || width !== this.#width) {
            this.#width = width
            this.#offsets = [0]
            for (const ratio of this.#ratios) this.#offsets.push(this.#offsets.at(-1) + ratio * this.#width)
            this.#geometryDirty = false
        }
        const indexes = [...this.#slots.keys()].sort((a, b) => a - b)
        const start = indexes[0] ?? 0
        const end = (indexes.at(-1) ?? -1) + 1
        this.#start = start
        this.#end = end
        this.#before.style.height = `${this.#offsets[start]}px`
        this.#after.style.height = `${this.#offsets.at(-1) - this.#offsets[end]}px`
        let nextElement = this.#pages.firstChild
        for (const index of indexes) {
            const slot = this.#slots.get(index)
            const height = `${this.#ratios[index] * this.#width}px`
            if (slot.element.style.height !== height) slot.element.style.height = height
            if (slot.element !== nextElement) this.#pages.insertBefore(slot.element, nextElement)
            nextElement = slot.element.nextSibling
        }
        this.#pages.style.width = `${this.#width}px`
        const targetTop = (this.#offsets[anchor.index] ?? 0)
            + (this.#ratios[anchor.index] ?? 0) * this.#width * anchor.fraction
        // Keep native momentum alive when only the mounted window changes.
        // Spacers preserve global coordinates; do not reassign an unchanged top.
        if (Math.abs(targetTop - this.scrollTop) > 0.5) this.scrollTop = targetTop
        this.#lastTop = this.scrollTop
    }
    #drop(slot) {
        slot.controller.abort()
        slot.resolve(false)
        slot.element.remove()
        if (slot.url) URL.revokeObjectURL(slot.url)
    }
    #window(index) {
        const anchor = this.#anchor()
        const top = this.scrollTop
        const visibleEnd = this.#locate(top + this.#viewportHeight)
        const end = Math.min(this.#ratios.length - 1, Math.max(index + 5, Math.min(index + 58, visibleEnd + 1)))
        const start = Math.max(0, Math.min(index - 5, end === this.#ratios.length - 1
            ? this.#locate(Math.max(0, (this.#offsets[index] ?? 0) - this.#viewportHeight)) : index))
        // Tiny strips may need more than five neighbors to fill the viewport.
        // Keep the expanded visible window bounded even for pathological books.
        const windowStart = Math.max(start, end - 63)
        let changed = false
        for (const [key, slot] of this.#slots) if (key < windowStart || key > end) {
            changed = true
            this.#drop(slot)
            this.#slots.delete(key)
        }
        for (let key = windowStart; key <= end; key++) {
            if (this.#slots.has(key)) continue
            changed = true
            const element = this.#doc.createElement('div')
            element.dataset.imageIndex = String(key)
            const slot = { index: key, element, controller: new AbortController(), data: null, started: false }
            slot.ready = new Promise(resolve => { slot.resolve = resolve })
            this.#slots.set(key, slot)
        }
        if (changed || this.#geometryDirty) this.#layout(anchor)
        this.#decodeVisible()
        this.#pump()
    }
    #pump() {
        if (this.#destroyed) return
        const queued = [...this.#slots.values()].filter(slot => !slot.started)
            .sort((a, b) => Math.abs(a.index - this.index) - Math.abs(b.index - this.index))
        while (this.#loading < 2 && queued.length) {
            const slot = queued.shift()
            slot.started = true
            this.#loading++
            void this.#book.getImagePage(slot.index, slot.controller.signal).then(data => {
                if (this.#destroyed || slot.controller.signal.aborted) return
                if (!data?.blob) throw new Error('Missing archive image data')
                const anchor = this.#anchor()
                slot.data = data
                if (data.width > 0 && data.height > 0 && this.#ratios[slot.index] !== data.height / data.width) {
                    this.#ratios[slot.index] = data.height / data.width
                    this.#geometryDirty = true
                }
                if (this.#geometryDirty) this.#layout(anchor)
                this.#window(this.index)
                slot.resolve(true)
            }).catch(error => {
                slot.error = error
                slot.resolve(false)
                if (!this.#destroyed && !isAbortError(error)) this.#onError(error, slot.index)
            }).finally(() => { this.#loading--; this.#pump() })
        }
    }
    #decodeVisible() {
        if (!this.#doc || this.index < 0) return
        const top = this.scrollTop
        const first = this.#locate(top)
        const last = this.#locate(top + this.#viewportHeight)
        for (const [index, slot] of this.#slots) {
            const visible = index >= first - 1 && index <= last + 1
            if (!visible && slot.url) {
                slot.element.replaceChildren()
                URL.revokeObjectURL(slot.url)
                slot.url = null
                slot.image = null
            }
            if (!visible || !slot.data || slot.image) continue
            const image = slot.image = this.#doc.createElement('img')
            image.alt = ''
            image.draggable = false
            slot.url = URL.createObjectURL(slot.data.blob)
            image.src = slot.url
            image.addEventListener('load', () => {
                if (this.#destroyed || slot.image !== image || !image.naturalWidth) return
                const ratio = image.naturalHeight / image.naturalWidth
                if (Math.abs(ratio - this.#ratios[index]) > 0.0001) {
                    const anchor = this.#anchor()
                    this.#ratios[index] = ratio
                    this.#geometryDirty = true
                    this.#layout(anchor)
                    this.#window(this.index)
                }
            }, { once: true })
            image.addEventListener('error', () => {
                if (!this.#destroyed && !slot.controller.signal.aborted) this.#onError(new Error('Archive image decode failed'), index)
            }, { once: true })
            slot.element.append(image)
        }
    }
    #onScroll = () => {
        if (this.#destroyed || this.#navigating || this.index < 0 || Math.abs(this.scrollTop - this.#lastTop) < 0.5) return
        this.#lastTop = this.scrollTop
        const atEnd = this.scrollTop >= this.scrollHeight - this.#viewportHeight - 1
        const index = atEnd ? this.#ratios.length - 1 : this.#locate(this.#lastTop)
        if (index !== this.index) {
            this.#doc.dispatchEvent(new Event('webtoon-user-input'))
            this.index = index
            this.#window(index)
            this.#onIndex(index, 'scroll')
        } else this.#decodeVisible()
    }
    async goTo(index, reason) {
        const generation = ++this.#generation
        this.#navigation?.abort()
        const navigation = this.#navigation = new AbortController()
        this.#navigating = true
        try {
            if (!await abortable(this.#ready, navigation.signal) || this.#destroyed || generation !== this.#generation) throw createAbortError()
            this.index = index
            this.#window(index)
            const slot = this.#slots.get(index)
            if (!await abortable(slot.ready, navigation.signal) || this.#destroyed || generation !== this.#generation) throw slot.error ?? createAbortError()
            this.#layout({ index, fraction: 0 })
            this.#decodeVisible()
            if (slot.image) await abortable(slot.image.decode(), navigation.signal)
            if (this.#destroyed || generation !== this.#generation) throw createAbortError()
            this.index = index
            if (!this.#loaded) { this.#loaded = true; this.#onLoad(this.#doc, index) }
            this.#onIndex(index, reason)
        } catch (error) {
            if (this.#destroyed || generation !== this.#generation) throw createAbortError()
            throw error
        } finally {
            if (generation === this.#generation) this.#navigating = false
        }
    }

    resize(scale = this.#scale) {
        if (Math.abs(this.#viewportWidth * scale - this.#width) < 0.5) { this.#decodeVisible(); return }
        const anchor = this.#anchor()
        this.#scale = scale
        this.#layout(anchor)
        this.#decodeVisible()
    }
    scroll(distance) {
        if (!Number.isFinite(distance) || !distance) return false
        const previousTop = this.scrollTop
        this.scrollTop += distance
        if (this.scrollTop === previousTop && !this.#navigating && this.boundary(Math.sign(distance))) {
            const edge = distance < 0 ? 0 : this.#ratios.length - 1
            if (this.index !== edge) {
                this.index = edge
                this.#window(edge)
                this.#onIndex(edge, 'scroll')
            }
        }
        this.#onScroll()
        return false
    }
    boundary(direction) {
        return direction < 0 ? this.scrollTop <= 1
            : this.scrollTop >= this.scrollHeight - this.#viewportHeight - 1
    }
    destroy() {
        this.#destroyed = true
        this.#generation++
        this.#navigation?.abort()
        this.#stopReady()
        this.#doc?.removeEventListener('scroll', this.#onScroll)
        this.#gestureCleanup?.()
        for (const slot of this.#slots.values()) this.#drop(slot)
        this.#slots.clear()
        this.#frame.remove()
        URL.revokeObjectURL(this.#url)
    }
}
