import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './user.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { UsersEventsController } from './users.events.controller';
import { KafkaModule } from '../kafka/kafka.module';

@Module({
  imports: [TypeOrmModule.forFeature([User]), KafkaModule],
  controllers: [UsersController, UsersEventsController],
  providers: [UsersService],
})
export class UsersModule {}
