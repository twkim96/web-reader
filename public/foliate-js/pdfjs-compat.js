// PDF.js 5.5 uses collection upsert in both the document and worker realms.
// Keep native implementations when available; load this before PDF.js in each realm.
for (const Collection of [Map, WeakMap]) {
    const { prototype } = Collection
    if (typeof prototype.getOrInsertComputed === 'function') continue
    const { has, get, set } = prototype
    Object.defineProperty(prototype, 'getOrInsertComputed', {
        configurable: true,
        writable: true,
        value: function getOrInsertComputed(key, callback) {
            const present = has.call(this, key)
            if (typeof callback !== 'function') throw new TypeError('callback must be a function')
            if (present) return get.call(this, key)
            const value = callback(key)
            set.call(this, key, value)
            return value
        },
    })
}
