import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientKafka } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { KAFKA_PRODUCER } from '../kafka/kafka.module';
import { TOPICS, UserCreatedEvent, OrderConfirmedEvent } from '../events/contracts';

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
    @Inject(KAFKA_PRODUCER) private readonly kafka: ClientKafka,
  ) {}

  async onModuleInit() {
    await this.kafka.connect();
  }

  async create(dto: CreateUserDto): Promise<User> {
    const existing = await this.repo.findOne({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException(`Email ${dto.email} is already registered`);
    }

    const user = await this.repo.save(this.repo.create(dto));

    const event: UserCreatedEvent = {
      userId: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt.toISOString(),
    };
    // key = userId, so all events for one user land on the same partition and
    // are therefore consumed in order.
    //
    // emit() returns a COLD observable: without awaiting/subscribing nothing is
    // ever sent. This is the #1 Kafka gotcha in NestJS.
    await firstValueFrom(
      this.kafka.emit(TOPICS.USER_CREATED, { key: user.id, value: event }),
    );
    this.logger.log(`published ${TOPICS.USER_CREATED} for ${user.id}`);

    return user;
  }

  findAll(): Promise<User[]> {
    return this.repo.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<User> {
    const user = await this.repo.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  /** Reaction to order.confirmed - updates this service's own read model. */
  async applyOrderConfirmed(event: OrderConfirmedEvent): Promise<void> {
    const user = await this.repo.findOne({ where: { id: event.userId } });
    if (!user) {
      this.logger.warn(`order.confirmed for unknown user ${event.userId}`);
      return;
    }
    user.ordersCount += 1;
    user.totalSpent = Number(user.totalSpent) + Number(event.totalPrice);
    await this.repo.save(user);
    this.logger.log(
      `user ${user.id}: ordersCount=${user.ordersCount} totalSpent=${user.totalSpent}`,
    );
  }
}
