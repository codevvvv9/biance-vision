/** Vite owns the deployment base. Feature routes never include it. */
export const adminBasename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/'
