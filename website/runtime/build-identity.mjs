/** Fail before accepting traffic if a static build belongs to another public origin. */
export function assertBuildIdentity(built, runtime) {
  if (!built || built.origin !== runtime.origin || built.brand !== runtime.brand) {
    throw new Error('Website build identity mismatch. Rebuild the website with the runtime WEBSITE_ORIGIN and current brand before starting it.')
  }
}
