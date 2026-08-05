import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxMessage } from './outbox.entity';
import { OutboxService } from './outbox.service';
import { OutboxRelayService } from './outbox-relay.service';
import { KafkaModule } from '../kafka/kafka.module';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([OutboxMessage]), KafkaModule],
  providers: [OutboxService, OutboxRelayService],
  exports: [OutboxService, OutboxRelayService],
})
export class OutboxModule {}
