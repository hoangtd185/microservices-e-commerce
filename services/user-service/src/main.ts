import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Same process serves HTTP *and* consumes Kafka. Nest calls this a hybrid app.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: 'user-service',
        brokers: (process.env.KAFKA_BROKERS ?? 'localhost:29092').split(','),
        retry: { retries: 10, initialRetryTime: 1000 },
      },
      // One groupId per service = each service gets its own copy of every event.
      consumer: { groupId: 'user-service-group' },
      subscribe: { fromBeginning: false },
      run: { autoCommit: true },
    },
  });

  await app.startAllMicroservices();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  new Logger('Bootstrap').log(`user-service listening on http://localhost:${port}`);
}

bootstrap();
