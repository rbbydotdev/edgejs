// Virtual fs module — served as a static ESM file.  L8 spike: prove
// that an import-map can map a bare specifier to a real module file.
// In production, the equivalent of this would be either a real file
// in the bundle OR a Service-Worker-synthesized response with the
// same shape.
export const readFileSync = (path) => `[virtual fs] ${path}`;
export default { readFileSync };
