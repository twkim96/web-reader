// Publication documents are untrusted. Parent-controlled listeners still work
// through same-origin access; publication-authored scripts must not execute.
export const PUBLICATION_SANDBOX = 'allow-same-origin'
