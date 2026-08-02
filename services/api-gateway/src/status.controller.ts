import { Controller, Get } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { ROUTES } from './routes';

@Controller()
export class StatusController {
  constructor(private readonly http: HttpService) {}

  /** Human-friendly index of what the gateway exposes. */
  @Get()
  index() {
    return {
      service: 'api-gateway',
      routes: ROUTES.map((r) => ({ path: `${r.prefix}/**`, service: r.name })),
      examples: [
        'POST /api/users        { "email": "a@b.com", "name": "Ada" }',
        'GET  /api/products',
        'POST /api/orders       { "userId": "...", "productId": "...", "quantity": 1 }',
        'GET  /api/orders?userId=...',
        'GET  /api/notifications?userId=...',
      ],
    };
  }

  /** Fan out to every service so one call tells you what is up. */
  @Get('health')
  async health() {
    // A service can own more than one prefix - check each service once.
    const services = [...new Map(ROUTES.map((r) => [r.target, r])).values()];

    const checks = await Promise.all(
      services.map(async (r) => {
        try {
          const res = await firstValueFrom(
            this.http.get(`${r.target}/health`, { timeout: 3000 }),
          );
          return { service: r.name, status: 'up', detail: res.data };
        } catch (err: any) {
          return { service: r.name, status: 'down', detail: err.message };
        }
      }),
    );

    return {
      gateway: 'ok',
      allUp: checks.every((c) => c.status === 'up'),
      services: checks,
    };
  }
}
