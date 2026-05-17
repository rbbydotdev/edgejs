'use strict'

module.exports = function nativeLlhttp () {
  // This file is selected at bundle time for Edge's built-in Undici artifact.
  // It should not be loaded by upstream/default Undici builds.
  const binding = internalBinding('undici')
  if (!binding || !binding.llhttp || binding.llhttp.native !== true) {
    throw new Error("internalBinding('undici').llhttp native parser is unavailable")
  }
  return { exports: binding.llhttp }
}
