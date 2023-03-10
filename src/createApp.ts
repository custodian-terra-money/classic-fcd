import * as path from 'path'
import * as Koa from 'koa'
import * as bodyParser from 'koa-body'
import * as Router from 'koa-router'
import * as morgan from 'koa-morgan'
import * as cors from '@koa/cors'
import * as helmet from 'koa-helmet'
import * as serve from 'koa-static'
import * as mount from 'koa-mount'
import { configureRoutes } from 'koa-joi-controllers'
import { koaSwagger } from 'koa2-swagger-ui'
import * as proxy from 'koa-proxies'

import config from 'config'
import { errorHandler, APIError, ErrorTypes } from 'lib/error'
import { error } from 'lib/response'
import { apiLogger as logger } from 'lib/logger'

const API_VERSION_PREFIX = '/v1'

const notFoundMiddleware: Koa.Middleware = (ctx) => {
  ctx.status = 404
}

function getRootApp(): Koa {
  // root app only contains the health check route
  const app = new Koa()
  const router = new Router()

  router.get('/health', async (ctx) => {
    ctx.status = 200
    ctx.body = 'OK'
  })

  app.use(router.routes())
  app.use(router.allowedMethods())
  return app
}

function createApiDocApp(): Koa {
  // static
  const app = new Koa()

  app
    .use(
      serve(path.resolve(__dirname, '..', 'static'), {
        maxage: 86400 * 1000
      })
    )
    .use(notFoundMiddleware)

  return app
}

function createSwaggerApp(): Koa {
  // swagger ui
  const app = new Koa()

  app
    .use(
      koaSwagger({
        routePrefix: '/',
        swaggerOptions: {
          url: '/static/swagger.json'
        }
      })
    )
    .use(notFoundMiddleware)

  return app
}

async function createAPIApp(): Promise<Koa> {
  const app = new Koa()

  app
    .use(errorHandler(error))
    .use(async (ctx, next) => {
      await next()

      ctx.set('Cache-Control', 'no-store, no-cache, must-revalidate')
      ctx.set('Pragma', 'no-cache')
      ctx.set('Expires', '0')
    })
    .use(
      bodyParser({
        formLimit: '512kb',
        jsonLimit: '512kb',
        textLimit: '512kb',
        multipart: true,
        onError: (error) => {
          throw new APIError(ErrorTypes.INVALID_REQUEST_ERROR, '', error.message, error)
        }
      })
    )

  // If we import controller before setting up variables for validation,
  // Joi will not allow us to validate it
  await import('./controller').then((module) => {
    configureRoutes(app, module.default)
  })

  app.use(notFoundMiddleware)
  return app
}

export default async (disableAPI = false): Promise<Koa> => {
  const app = getRootApp()

  if (disableAPI) {
    // Return app with only health check if api is disbaled.
    logger.info('API Disabled')
    return app
  }

  logger.info('Adding REST API')
  app.proxy = true

  const apiDocApp = createApiDocApp()
  const swaggerApp = createSwaggerApp()
  const apiApp = await createAPIApp()

  app
    .use(morgan('common'))
    .use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: [`'self'`],
            scriptSrc: [`'self'`, `'unsafe-inline'`, `'unsafe-eval'`, 'cdnjs.cloudflare.com'],
            fontSrc: [`'self'`, 'https:', 'data:'],
            objectSrc: [`'none'`],
            imgSrc: [`'self'`, 'data:', 'validator.swagger.io'],
            styleSrc: [`'self'`, 'https:', `'unsafe-inline'`],
            upgradeInsecureRequests: [],
            blockAllMixedContent: []
          }
        }
      })
    )
    .use(cors())
    .use(mount('/static', apiDocApp))
    .use(mount('/apidoc', apiDocApp))
    .use(mount('/swagger', swaggerApp))
    .use(mount(API_VERSION_PREFIX, apiApp))

  // proxy to lcd
  app.use(
    proxy('', {
      target: config.BYPASS_URI,
      changeOrigin: true,
      logs: process.env.NODE_ENV !== 'production'
    })
  )

  return app
}
