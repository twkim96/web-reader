export class LatestTask {
    #generation = 0
    #controller = null

    begin() {
        this.#controller?.abort()
        const controller = new AbortController()
        const task = {
            generation: ++this.#generation,
            controller,
            signal: controller.signal,
        }
        this.#controller = controller
        return task
    }

    isCurrent(task) {
        return task.generation === this.#generation && !task.signal.aborted
    }

    finish(task) {
        if (this.isCurrent(task)) this.#controller = null
    }

    cancel() {
        this.#generation += 1
        this.#controller?.abort()
        this.#controller = null
    }
}

export const createAbortError = () => new DOMException(
    'The operation was aborted.',
    'AbortError',
)

export const isAbortError = error => error?.name === 'AbortError'

export class LatestFrame {
    #cancelFrame
    #frameID = null
    #requestFrame
    #run = null
    #waiters = []

    constructor({
        requestFrame = callback => requestAnimationFrame(callback),
        cancelFrame = frameID => cancelAnimationFrame(frameID),
    } = {}) {
        this.#requestFrame = requestFrame
        this.#cancelFrame = cancelFrame
    }

    schedule(run) {
        this.#run = run
        const promise = new Promise((resolve, reject) => {
            this.#waiters.push({ resolve, reject })
        })
        if (this.#frameID === null) {
            this.#frameID = this.#requestFrame(() => {
                this.#frameID = null
                const currentRun = this.#run
                const waiters = this.#waiters.splice(0)
                Promise.resolve().then(currentRun).then(
                    value => waiters.forEach(({ resolve }) => resolve(value)),
                    error => waiters.forEach(({ reject }) => reject(error)),
                )
            })
        }
        return promise
    }

    cancel() {
        if (this.#frameID !== null) this.#cancelFrame(this.#frameID)
        this.#frameID = null
        this.#run = null
        this.#waiters.splice(0).forEach(({ resolve }) => resolve())
    }
}
