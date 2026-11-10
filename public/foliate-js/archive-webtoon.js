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
    #onIndex
    #onLoad
    #loaded = false
    #onError
    #ready
    #stopReady
    #before
    #pages
    #after
    constructor(host, root, book, { onIndex, onLoad, onError }) {
        this.#host = host
        this.#book = book
        this.#onIndex = onIndex
        this.#onLoad = onLoad
        this.#onError = onError
        this.#ratios = Array(book.sections.length).fill(2)
        const frame = this.#frame = document.createElement('iframe')
        frame.setAttribute('sandbox', PUBLICATION_SANDBOX)
        frame.setAttribute('scrolling', 'no')
        frame.setAttribute('part', 'filter')
        frame.style.cssText = 'display:block;border:0;width:100%;height:1px;overflow:hidden'
        this.#ready = new Promise(resolve => {
            this.#stopReady = () => resolve(false)
            frame.addEventListener('load', () => {
                if (this.#destroyed || !frame.contentDocument?.body) return resolve(false)
                this.#doc = frame.contentDocument
                this.#before = this.#doc.querySelector('#before')
                this.#pages = this.#doc.querySelector('#pages')
                this.#after = this.#doc.querySelector('#after')
                resolve(true)
            }, { once: true })
        })
        this.#url = URL.createObjectURL(new Blob([`<!doctype html><meta charset="utf-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'unsafe-inline'">
            <style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;overflow-anchor:none}
            #pages>div{margin:0;padding:0;overflow:hidden}img{display:block;width:100%;height:100%;object-fit:contain}</style>
            <div id="before"></div><div id="pages"></div><div id="after"></div>`], { type: 'text/html' }))
        frame.src = this.#url
        root.append(frame)
        Object.assign(host.style, { display: 'block', overflowAnchor: 'none' })
        host.addEventListener('scroll', this.#onScroll, { passive: true })
    }
    get doc() { return this.#doc }
    #anchor() {
        const top = this.#host.scrollTop + (this.#offsets[this.#start] ?? 0)
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
        this.#width = Math.max(1, this.#host.clientWidth) * this.#scale
        this.#offsets = [0]
        for (const ratio of this.#ratios) this.#offsets.push(this.#offsets.at(-1) + ratio * this.#width)
        const indexes = [...this.#slots.keys()].sort((a, b) => a - b)
        const start = indexes[0] ?? 0
        const end = (indexes.at(-1) ?? -1) + 1
        this.#start = start
        this.#end = end
        this.#before.style.height = this.#after.style.height = '0px'
        for (const index of indexes) {
            const slot = this.#slots.get(index)
            slot.element.style.height = `${this.#ratios[index] * this.#width}px`
            this.#pages.append(slot.element)
        }
        this.#frame.style.width = `${this.#width}px`
        this.#frame.style.height = `${this.#offsets[end] - this.#offsets[start]}px`
        this.#host.scrollTop = (this.#offsets[anchor.index] ?? 0)
            + (this.#ratios[anchor.index] ?? 0) * this.#width * anchor.fraction - this.#offsets[start]
        this.#lastTop = this.#host.scrollTop
    }
    #drop(slot) {
        slot.controller.abort()
        slot.resolve(false)
        slot.element.remove()
        if (slot.url) URL.revokeObjectURL(slot.url)
    }
    #window(index) {
        const anchor = this.#anchor()
        const top = this.#host.scrollTop + (this.#offsets[this.#start] ?? 0)
        const visibleEnd = this.#locate(top + this.#host.clientHeight)
        const end = Math.min(this.#ratios.length - 1, Math.max(index + 5, Math.min(index + 58, visibleEnd + 1)))
        const start = Math.max(0, Math.min(index - 5, end === this.#ratios.length - 1
            ? this.#locate(Math.max(0, (this.#offsets[index] ?? 0) - this.#host.clientHeight)) : index))
        // Tiny strips may need more than five neighbors to fill the viewport.
        // Keep the expanded visible window bounded even for pathological books.
        const windowStart = Math.max(start, end - 63)
        for (const [key, slot] of this.#slots) if (key < windowStart || key > end) {
            this.#drop(slot)
            this.#slots.delete(key)
        }
        for (let key = windowStart; key <= end; key++) {
            if (this.#slots.has(key)) continue
            const element = this.#doc.createElement('div')
            element.dataset.imageIndex = String(key)
            const slot = { index: key, element, controller: new AbortController(), data: null, started: false }
            slot.ready = new Promise(resolve => { slot.resolve = resolve })
            this.#slots.set(key, slot)
        }
        this.#layout(anchor)
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
                if (data.width > 0 && data.height > 0) this.#ratios[slot.index] = data.height / data.width
                this.#layout(anchor)
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
        const top = this.#host.scrollTop + this.#offsets[this.#start]
        const first = this.#locate(top)
        const last = this.#locate(top + this.#host.clientHeight)
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
        if (this.#destroyed || this.#navigating || this.index < 0 || Math.abs(this.#host.scrollTop - this.#lastTop) < 0.5) return
        this.#lastTop = this.#host.scrollTop
        const atEnd = this.#end === this.#ratios.length && this.#host.scrollTop >= this.#host.scrollHeight - this.#host.clientHeight - 1
        const index = atEnd ? this.#ratios.length - 1 : this.#locate(this.#lastTop + this.#offsets[this.#start])
        if (index !== this.index) {
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
        if (Math.abs(this.#host.clientWidth * scale - this.#width) < 0.5) { this.#decodeVisible(); return }
        const anchor = this.#anchor()
        this.#scale = scale
        this.#layout(anchor)
        this.#decodeVisible()
    }
    scroll(distance) {
        if (!Number.isFinite(distance) || !distance) return false
        const previousTop = this.#host.scrollTop
        this.#host.scrollTop += distance
        if (this.#host.scrollTop === previousTop && !this.#navigating && this.boundary(Math.sign(distance))) {
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
        return direction < 0 ? this.#start === 0 && this.#host.scrollTop <= 1
            : this.#end === this.#ratios.length && this.#host.scrollTop >= this.#host.scrollHeight - this.#host.clientHeight - 1
    }
    destroy() {
        this.#destroyed = true
        this.#generation++
        this.#navigation?.abort()
        this.#stopReady()
        this.#host.removeEventListener('scroll', this.#onScroll)
        for (const slot of this.#slots.values()) this.#drop(slot)
        this.#slots.clear()
        this.#frame.remove()
        URL.revokeObjectURL(this.#url)
    }
}
