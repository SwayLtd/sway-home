import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { refusal } from '#services/origin_guard'

/**
 * Refuses what a foreign web page sends, and requests reaching the hub under a public name
 * (DNS rebinding), before CORS or any route sees them. See `origin_guard`.
 */
export default class OriginGuardMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const reason = refusal({ origin: ctx.request.header('origin'), host: ctx.request.header('host') })
    if (reason) {
      ctx.response.status(403).send({ error: reason })
      return
    }
    return next()
  }
}
