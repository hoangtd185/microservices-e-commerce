import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

export const KAFKA_PRODUCER = 'KAFKA_PRODUCER';

const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:29092').split(',');

@Module({
  imports: [
    ClientsModule.register([
      {
        name: KAFKA_PRODUCER,
        transport: Transport.KAFKA,
        options: {
          client: {
            clientId: 'order-service-producer',
            brokers,
            retry: { retries: 10, initialRetryTime: 1000 },
          },
          producerOnlyMode: true,
        },
      },
    ]),
  ],
  exports: [ClientsModule],
})
export class KafkaModule {}
