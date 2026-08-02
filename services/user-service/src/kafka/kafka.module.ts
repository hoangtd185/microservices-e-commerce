import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

export const KAFKA_PRODUCER = 'KAFKA_PRODUCER';

const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:29092').split(',');

/**
 * Producer side of Kafka. `producerOnlyMode` means this client never joins a
 * consumer group - it only publishes. Consuming is wired up separately in
 * main.ts via connectMicroservice().
 */
@Module({
  imports: [
    ClientsModule.register([
      {
        name: KAFKA_PRODUCER,
        transport: Transport.KAFKA,
        options: {
          client: {
            clientId: 'user-service-producer',
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
