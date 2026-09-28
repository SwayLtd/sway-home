import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',

  // A local console, rendered in the browser. There is no crawler to serve, the hub is not
  // reachable while the page is being server-rendered, and every screen here is built from
  // live device state - so server rendering produces a shell that is guaranteed to differ
  // from what hydrates over it. Turning it off removes that whole class of bug rather than
  // patching each one with ClientOnly.
  ssr: false,
  devtools: { enabled: true },

  modules: ['@nuxt/icon', '@vueuse/nuxt'],

  css: ['~/assets/app.css'],

  vite: {
    plugins: [tailwindcss()],
  },

  app: {
    head: {
      title: 'Sway Home',
      htmlAttrs: { lang: 'fr', 'data-theme': 'sway' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'color-scheme', content: 'light dark' },
        { name: 'description', content: 'Console Sway Home: la maison, ses appareils et son assistant.' },
      ],
      link: [{ rel: 'icon', href: '/favicon.svg' }],
    },
  },

  icon: {
    // Phosphor for the chrome and the controls, bundled rather than fetched at runtime so
    // the console works with no internet - which is the whole point of a local hub.
    serverBundle: { collections: ['ph'] },
    // Off /api: everything under /api is proxied to the hub in dev, and the module's default
    // endpoint (/api/_nuxt_icon) would be answered by AdonisJS with a 404 instead of an icon.
    localApiEndpoint: '/_icons',
    clientBundle: { scan: true, sizeLimitKb: 512 },
  },

  runtimeConfig: {
    public: {
      // The hub runs as its own process, usually on the same machine. In production the
      // console is served by the hub itself and this becomes a same-origin relative path.
      hubUrl: process.env.NUXT_PUBLIC_HUB_URL ?? 'http://localhost:3333',
    },
  },

  nitro: {
    devProxy: {
      '/api': { target: 'http://localhost:3333/api', changeOrigin: true },
    },
  },

  typescript: { strict: true, typeCheck: false },

  experimental: { viewTransition: true },
})
