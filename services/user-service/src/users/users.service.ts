import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { User } from './user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { OutboxService } from '../outbox/outbox.service';
import { TOPICS, UserCreatedEvent, OrderConfirmedEvent } from '../events/contracts';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {}

  /** Passwordless creation, for admin/seed use. Public signup is /auth/register. */
  async create(dto: CreateUserDto): Promise<User> {
    const existing = await this.repo.findOne({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException(`Email ${dto.email} is already registered`);
    }

    return this.dataSource.transaction(async (manager) => {
      const user = await manager.save(manager.create(User, dto));

      const event: UserCreatedEvent = {
        userId: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt.toISOString(),
      };
      // key = userId, so all events for one user land on the same partition
      // and are therefore consumed in order.
      await this.outbox.record(manager, {
        topic: TOPICS.USER_CREATED,
        key: user.id,
        payload: event as any,
      });

      this.logger.log(`created user ${user.id}`);
      return user;
    });
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
