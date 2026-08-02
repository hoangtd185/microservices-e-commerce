import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { ProxyController } from './proxy.controller';
import { StatusController } from './status.controller';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), HttpModule],
  // StatusController first so GET / and GET /health are not swallowed by the proxy.
  controllers: [StatusController, ProxyController],
})
export class AppModule {}
