import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { service: 'user-service', status: 'ok', ts: new Date().toISOString() };
  }
}
