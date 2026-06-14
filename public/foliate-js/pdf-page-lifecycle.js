export const MAX_PDF_CANVAS_PIXELS = 8_388_608
export const MAX_PDF_CANVAS_DIMENSION = 8_192

const positiveNumber = (value, fallback) => (
    Number.isFinite(value) && value > 0 ? value : fallback
)

export const getPDFRenderMetrics = ({
    width,
    height,
    zoom,
    pixelRatio,
    maxPixels = MAX_PDF_CANVAS_PIXELS,
    maxDimension = MAX_PDF_CANVAS_DIMENSION,
}) => {
    const pageWidth = positiveNumber(width, 1)
    const pageHeight = positiveNumber(height, 1)
    const displayZoom = positiveNumber(zoom, 1)
    const outputRatio = positiveNumber(pixelRatio, 1)
    const desiredScale = displayZoom * outputRatio
    const pixelScale = Math.sqrt(
        positiveNumber(maxPixels, MAX_PDF_CANVAS_PIXELS)
        / (pageWidth * pageHeight),
    )
    const dimensionScale = Math.min(
        positiveNumber(maxDimension, MAX_PDF_CANVAS_DIMENSION) / pageWidth,
        positiveNumber(maxDimension, MAX_PDF_CANVAS_DIMENSION) / pageHeight,
    )
    const renderScale = Math.min(desiredScale, pixelScale, dimensionScale)

    return {
        canvasHeight: Math.max(1, Math.floor(pageHeight * renderScale)),
        canvasWidth: Math.max(1, Math.floor(pageWidth * renderScale)),
        displayScale: displayZoom / renderScale,
        renderScale,
    }
}

export const cleanupPDFPageAfter = async (page, idle) => {
    if (page.cleanup()) return true
    await Promise.resolve(idle).catch(() => {})
    return page.cleanup()
}
