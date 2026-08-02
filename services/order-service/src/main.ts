import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: 'order-service',
        brokers: (process.env.KAFKA_BROKERS ?? 'localhost:29092').split(','),
        retry: { retries: 10, initialRetryTime: 1000 },
      },
      consumer: { groupId: 'order-service-group' },
      subscribe: { fromBeginning: false },
      run: { autoCommit: true },
    },
  });

  await app.startAllMicroservices();

  const port = Number(process.env.PORT ?? 3002);
  await app.listen(port);
  new Logger('Bootstrap').log(`order-service listening on http://localhost:${port}`);
}

bootstrap();
