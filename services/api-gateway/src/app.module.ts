import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { JwtModule } from '@nestjs/jwt';
import { ProxyController } from './proxy.controller';
import { StatusController } from './status.controller';
import { IdentityService } from './auth/identity.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    HttpModule,
    JwtModule.register({
      // Verify only - the gateway never signs tokens. That is user-service's job.
      secret: process.env.JWT_SECRET ?? 'dev-only-insecure-secret',
    }),
  ],
  // StatusController first so GET / and GET /health are not swallowed by the proxy.
  controllers: [StatusController, ProxyController],
  providers: [IdentityService],
})
export class AppModule {}
