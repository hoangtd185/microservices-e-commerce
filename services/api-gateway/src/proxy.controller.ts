import { randomUUID } from 'crypto';
import { All, Controller, Logger, Req, Res } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { Request, Response } from 'express';
import { ROUTES } from './routes';

const METHODS_WITHOUT_BODY = ['GET', 'HEAD', 'DELETE', 'OPTIONS'];

/**
 * The whole gateway in one handler.
 *
 * Everything under /api/* is matched against the routing table, rewritten and
 * forwarded to the owning service. Because every request funnels through here,
 * this is where cross-cutting concerns belong: auth, rate limiting, request
 * ids, logging, response shaping. Add them once instead of four times.
 */
@Controller()
export class ProxyController {
  private readonly logger = new Logger('Gateway');

  constructor(private readonly http: HttpService) {}

  @All('api/*')
  async proxy(@Req() req: Request, @Res() res: Response) {
    const rule = ROUTES.find(
      (r) => req.path === r.prefix || req.path.startsWith(`${r.prefix}/`),
    );

    if (!rule) {
      res.status(404).json({
        statusCode: 404,
        message: `No route for ${req.path}`,
        availableRoutes: ROUTES.map((r) => r.prefix),
      });
      return;
    }

    const requestId = (req.headers['x-request-id'] as string) ?? randomUUID();
    const suffix = req.path.slice(rule.prefix.length);
    const url = `${rule.target}${rule.rewrite}${suffix}`;

    try {
      const upstream = await firstValueFrom(
        this.http.request({
          method: req.method as any,
          url,
          params: req.query,
          data: METHODS_WITHOUT_BODY.includes(req.method) ? undefined : req.body,
          timeout: 10_000,
          headers: {
            'content-type': 'application/json',
            'x-request-id': requestId,
            ...(req.headers.authorization
              ? { authorization: req.headers.authorization }
              : {}),
            // Must be forwarded or the client's retry protection silently
            // stops working at the gateway.
            ...(req.headers['idempotency-key']
              ? { 'idempotency-key': req.headers['idempotency-key'] as string }
              : {}),
          },
          // Let 4xx from the service flow through untouched instead of throwing.
          validateStatus: () => true,
        }),
      );

      this.logger.log(
        `${req.method} ${req.path} -> ${rule.name}${rule.rewrite}${suffix} [${upstream.status}]`,
      );

      res
        .status(upstream.status)
        .set({
          'x-served-by': rule.name,
          'x-request-id': requestId,
          ...(upstream.headers['idempotent-replay']
            ? { 'idempotent-replay': String(upstream.headers['idempotent-replay']) }
            : {}),
        })
        .json(upstream.data);
    } catch (err: any) {
      // The service is down / unreachable: that is a gateway-level failure.
      this.logger.error(`${req.method} ${req.path} -> ${rule.name} failed: ${err.message}`);
      res.status(503).json({
        statusCode: 503,
        message: `${rule.name} is unavailable`,
        detail: err.message,
        requestId,
      });
    }
  }
}
