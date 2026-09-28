import { defineConfig } from '@adonisjs/cors'
import { isAllowedOrigin } from '#services/origin_guard'

/**
 * Configuration options to tweak the CORS policy. The following
 * options are documented on the official documentation website.
 *
 * https://docs.adonisjs.com/guides/security/cors
 */
const corsConfig = defineConfig({
  enabled: true,
  // Only pages served from the house (see origin_guard); a foreign site gets no CORS answer.
  origin: (origin) => isAllowedOrigin(origin),
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
  headers: true,
  exposeHeaders: [],
  // The hub sets no cookie: nothing to send along.
  credentials: false,
  maxAge: 90,
})

export default corsConfig
