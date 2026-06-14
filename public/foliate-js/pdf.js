const pdfjsPath = path => new URL(`vendor/pdfjs/${path}`, import.meta.url).toString()

import './vendor/pdfjs/pdf.mjs'
import { LatestFrame } from './latest-task.js'
import {
    cleanupPDFPageAfter,
    getPDFRenderMetrics,
} from './pdf-page-lifecycle.js'
const pdfjsLib = globalThis.pdfjsLib
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.mjs')

const fetchText = async url => await (await fetch(url)).text()

// https://raw.githubusercontent.com/mozilla/pdf.js/refs/tags/v5.5.207/web/text_layer_builder.css
const textLayerBuilderCSS = await fetchText(pdfjsPath('text_layer_builder.css'))

// https://raw.githubusercontent.com/mozilla/pdf.js/refs/tags/v5.5.207/web/annotation_layer_builder.css
const annotationLayerBuilderCSS = await fetchText(pdfjsPath('annotation_layer_builder.css'))
const MAX_CACHED_PAGES = 4

const isRenderCancelled = error => error?.name === 'RenderingCancelledException'
    || error?.name === 'AbortError'

const clearPageLayers = doc => {
    doc.querySelector('#canvas')?.replaceChildren()
    doc.querySelector('.textLayer')?.replaceChildren()
    doc.querySelector('.annotationLayer')?.replaceChildren()
}

const createPageRenderer = page => {
    const states = new Map()
    const activeRenders = new Set()
    let destroyed = false
    let destroyPromise = null

    const cleanupState = doc => {
        const state = states.get(doc)
        if (!state) return
        state.destroyed = true
        state.generation += 1
        state.frame.cancel()
        state.renderTask?.cancel()
        state.textLayer?.cancel()
        clearPageLayers(doc)
        states.delete(doc)
    }

    const render = async (doc, zoom, state) => {
        const baseViewport = page.getViewport({ scale: 1 })
        const {
            canvasHeight,
            canvasWidth,
            displayScale,
            renderScale,
        } = getPDFRenderMetrics({
            width: baseViewport.width,
            height: baseViewport.height,
            zoom,
            pixelRatio: devicePixelRatio,
        })
        const renderKey = `${renderScale}:${displayScale}`
        if (
            state.completedKey === renderKey
            && state.renderingGeneration === null
        ) return

        const generation = ++state.generation
        state.renderingGeneration = generation
        state.completedKey = null
        state.renderTask?.cancel()
        state.textLayer?.cancel()
        state.renderTask = null
        state.textLayer = null
        clearPageLayers(doc)

        try {
            doc.documentElement.style.transform = `scale(${displayScale})`
            doc.documentElement.style.transformOrigin = 'top left'
            doc.documentElement.style.setProperty('--scale-factor', renderScale)
            const viewport = page.getViewport({ scale: renderScale })

            // PDF.js loads fonts into this module's owner document. Render on a
            // canvas from that document, then adopt it into the page iframe.
            const canvas = document.createElement('canvas')
            canvas.height = canvasHeight
            canvas.width = canvasWidth
            const canvasContext = canvas.getContext('2d')
            const renderTask = page.render({ canvasContext, viewport })
            state.renderTask = renderTask
            try {
                await renderTask.promise
            } catch (error) {
                if (isRenderCancelled(error) || generation !== state.generation) return
                throw error
            } finally {
                if (state.renderTask === renderTask) state.renderTask = null
            }
            if (state.destroyed || generation !== state.generation) return
            doc.querySelector('#canvas')?.replaceChildren(doc.adoptNode(canvas))

            const textContentSource = await page.streamTextContent()
            if (state.destroyed || generation !== state.generation) return
            const textContainer = doc.createElement('div')
            textContainer.className = 'textLayer'
            const textLayer = new pdfjsLib.TextLayer({
                textContentSource,
                container: textContainer,
                viewport,
            })
            state.textLayer = textLayer
            try {
                await textLayer.render()
            } catch (error) {
                if (isRenderCancelled(error) || generation !== state.generation) return
                throw error
            } finally {
                if (state.textLayer === textLayer) state.textLayer = null
            }
            if (state.destroyed || generation !== state.generation) return

            for (const hiddenCanvas of doc.querySelectorAll('.hiddenCanvasElement'))
                Object.assign(hiddenCanvas.style, {
                    position: 'absolute',
                    top: '0',
                    left: '0',
                    width: '0',
                    height: '0',
                    display: 'none',
                })

            const endOfContent = doc.createElement('div')
            endOfContent.className = 'endOfContent'
            textContainer.append(endOfContent)
            textContainer.onpointerdown = () => textContainer.classList.add('selecting')
            textContainer.onpointerup = () => textContainer.classList.remove('selecting')

            const annotationContainer = doc.createElement('div')
            annotationContainer.className = 'annotationLayer'
            const linkService = {
                goToDestination: () => {},
                getDestinationHash: dest => JSON.stringify(dest),
                addLinkAttributes: (link, url) => link.href = url,
            }
            await new pdfjsLib.AnnotationLayer({
                page,
                viewport,
                div: annotationContainer,
                linkService,
            }).render({ annotations: await page.getAnnotations() })
            if (state.destroyed || generation !== state.generation) return

            doc.querySelector('.textLayer')?.replaceWith(textContainer)
            doc.querySelector('.annotationLayer')?.replaceWith(annotationContainer)
            state.completedKey = renderKey
        } finally {
            if (state.renderingGeneration === generation) {
                state.renderingGeneration = null
            }
        }
    }

    const onZoom = ({ doc, scale }) => {
        if (destroyed) return Promise.resolve()
        let state = states.get(doc)
        if (!state) {
            state = {
                completedKey: null,
                destroyed: false,
                frame: new LatestFrame(),
                generation: 0,
                renderTask: null,
                renderingGeneration: null,
                textLayer: null,
                zoom: scale,
            }
            states.set(doc, state)
        }
        state.zoom = scale
        return state.frame.schedule(() => {
            const operation = render(doc, state.zoom, state)
            activeRenders.add(operation)
            operation.then(
                () => activeRenders.delete(operation),
                () => activeRenders.delete(operation),
            )
            return operation
        })
    }
    onZoom.cleanup = cleanupState
    onZoom.destroy = () => {
        if (destroyPromise) return destroyPromise
        destroyed = true
        for (const doc of [...states.keys()]) cleanupState(doc)
        destroyPromise = cleanupPDFPageAfter(
            page,
            Promise.allSettled([...activeRenders]),
        )
        return destroyPromise
    }
    return onZoom
}

const renderPage = async (page, getImageBlob) => {
    const baseViewport = page.getViewport({ scale: 1 })
    if (getImageBlob) {
        const {
            canvasHeight,
            canvasWidth,
            renderScale,
        } = getPDFRenderMetrics({
            width: baseViewport.width,
            height: baseViewport.height,
            zoom: 1,
            pixelRatio: 1,
        })
        const viewport = page.getViewport({ scale: renderScale })
        const canvas = document.createElement('canvas')
        canvas.height = canvasHeight
        canvas.width = canvasWidth
        const canvasContext = canvas.getContext('2d')
        try {
            await page.render({ canvasContext, viewport }).promise
            return await new Promise(resolve => canvas.toBlob(resolve))
        } finally {
            page.cleanup()
        }
    }
    const src = URL.createObjectURL(new Blob([`
        <!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=${baseViewport.width}, height=${baseViewport.height}">
        <style>
        html, body {
            margin: 0;
            padding: 0;
        }
        /*
        https://github.com/mozilla/pdf.js/commit/bd05b255fabfc313b194bfe9a17ccded4d90fb5a
        */
        :root {
          --user-unit: 1;
          --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
          --scale-round-x: 1px;
          --scale-round-y: 1px;
        }
        ${textLayerBuilderCSS}
        ${annotationLayerBuilderCSS}
        </style>
        <div id="canvas"></div>
        <div class="textLayer"></div>
        <div class="annotationLayer"></div>
    `], { type: 'text/html' }))
    return { src, onZoom: createPageRenderer(page) }
}

const makeTOCItem = item => ({
    label: item.title,
    href: JSON.stringify(item.dest),
    subitems: item.items.length ? item.items.map(makeTOCItem) : null,
})

export const makePDF = async file => {
    const transport = new pdfjsLib.PDFDataRangeTransport(file.size, [])
    transport.requestDataRange = (begin, end) => {
        file.slice(begin, end).arrayBuffer().then(chunk => {
            transport.onDataRange(begin, chunk)
        })
    }
    const pdf = await pdfjsLib.getDocument({
        range: transport,
        cMapUrl: pdfjsPath('cmaps/'),
        standardFontDataUrl: pdfjsPath('standard_fonts/'),
        isEvalSupported: false,
    }).promise

    const book = { rendition: { layout: 'pre-paginated', spread: 'none' } }

    const { metadata, info } = await pdf.getMetadata() ?? {}
    // TODO: for better results, parse `metadata.getRaw()`
    book.metadata = {
        title: metadata?.get('dc:title') ?? info?.Title,
        author: metadata?.get('dc:creator') ?? info?.Author,
        contributor: metadata?.get('dc:contributor'),
        description: metadata?.get('dc:description') ?? info?.Subject,
        language: metadata?.get('dc:language'),
        publisher: metadata?.get('dc:publisher'),
        subject: metadata?.get('dc:subject'),
        identifier: metadata?.get('dc:identifier'),
        source: metadata?.get('dc:source'),
        rights: metadata?.get('dc:rights'),
    }

    const outline = await pdf.getOutline()
    book.toc = outline?.map(makeTOCItem)

    const cache = new Map()
    const pending = new Map()
    const cleanupTasks = new Set()
    const auxiliaryTasks = new Set()
    let destroyed = false
    let destroyPromise = null

    const trackCleanup = task => {
        const cleanupTask = Promise.resolve(task)
        cleanupTasks.add(cleanupTask)
        cleanupTask.then(
            () => cleanupTasks.delete(cleanupTask),
            () => cleanupTasks.delete(cleanupTask),
        )
        return cleanupTask
    }

    const trackAuxiliary = task => {
        auxiliaryTasks.add(task)
        task.then(
            () => auxiliaryTasks.delete(task),
            () => auxiliaryTasks.delete(task),
        )
        return task
    }

    const releasePage = cached => {
        if (!cached) return
        URL.revokeObjectURL(cached.source.src)
        trackCleanup(cached.source.onZoom.destroy())
    }

    const revokePage = index => {
        const cached = cache.get(index)
        if (!cached) return
        cache.delete(index)
        releasePage(cached)
    }

    const pageID = index => `page-${index + 1}`
    book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
        id: pageID(i),
        load: async signal => {
            if (destroyed) throw new Error('PDF source is closed')
            if (signal?.aborted)
                throw new DOMException('PDF page load aborted', 'AbortError')
            const cached = cache.get(i)
            if (cached) {
                cache.delete(i)
                cache.set(i, cached)
                return cached.source
            }
            const pendingPage = pending.get(i)
            if (pendingPage && !pendingPage.signal?.aborted)
                return pendingPage.promise

            const loadPromise = (async () => {
                const page = await pdf.getPage(i + 1)
                if (destroyed || signal?.aborted) {
                    page.cleanup()
                    if (signal?.aborted)
                        throw new DOMException('PDF page load aborted', 'AbortError')
                    throw new Error('PDF source is closed')
                }
                const source = await renderPage(page)
                const cachedPage = { page, source }
                if (destroyed || signal?.aborted) {
                    releasePage(cachedPage)
                    if (signal?.aborted)
                        throw new DOMException('PDF page load aborted', 'AbortError')
                    throw new Error('PDF source is closed')
                }
                cache.set(i, cachedPage)
                while (cache.size > MAX_CACHED_PAGES)
                    revokePage(cache.keys().next().value)
                return source
            })().finally(() => {
                if (pending.get(i)?.promise === loadPromise) pending.delete(i)
            })
            pending.set(i, { promise: loadPromise, signal })
            return loadPromise
        },
        size: 1000,
    }))
    book.isExternal = uri => /^\w+:/i.test(uri)
    book.resolveHref = async href => {
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        const index = await pdf.getPageIndex(dest[0])
        return { index }
    }
    book.splitTOCHref = async href => {
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        const index = await pdf.getPageIndex(dest[0])
        return [pageID(index), null]
    }
    book.getTOCFragment = doc => doc.documentElement
    book.getCover = () => {
        if (destroyed) return Promise.reject(new Error('PDF source is closed'))
        return trackAuxiliary((async () => {
            const page = await pdf.getPage(1)
            if (destroyed) {
                page.cleanup()
                throw new Error('PDF source is closed')
            }
            return renderPage(page, true)
        })())
    }
    book.destroy = () => {
        if (destroyed) return destroyPromise
        destroyed = true
        for (const index of cache.keys()) revokePage(index)
        destroyPromise = Promise.allSettled([
            ...[...pending.values()].map(({ promise }) => promise),
            ...auxiliaryTasks,
            ...cleanupTasks,
        ]).then(async () => {
            await Promise.allSettled([...cleanupTasks])
            await pdf.destroy()
        })
        return destroyPromise
    }
    return book
}
