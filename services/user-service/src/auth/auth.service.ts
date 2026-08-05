import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { RegisterDto, LoginDto } from './dto/auth.dto';
import { hashPassword, verifyPassword } from './password';
import { OutboxService } from '../outbox/outbox.service';
import { TOPICS, UserCreatedEvent } from '../events/contracts';

export interface AuthResult {
  accessToken: string;
  expiresIn: string;
  user: { id: string; email: string; name: string };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly expiresIn = process.env.JWT_EXPIRES_IN ?? '1h';

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.users.findOne({ where: { email: dto.email } });
    if (existing) throw new ConflictException(`Email ${dto.email} is already registered`);

    // Hash BEFORE opening the transaction: scrypt is deliberately slow
    // (~100ms), and slow work must never happen while a transaction holds locks.
    const passwordHash = await hashPassword(dto.password);

    const user = await this.dataSource.transaction(async (manager) => {
      const saved = await manager.save(
        manager.create(User, { email: dto.email, name: dto.name, passwordHash }),
      );

      const event: UserCreatedEvent = {
        userId: saved.id,
        email: saved.email,
        name: saved.name,
        createdAt: saved.createdAt.toISOString(),
      };
      await this.outbox.record(manager, {
        topic: TOPICS.USER_CREATED,
        key: saved.id,
        payload: event as any,
      });

      return saved;
    });

    this.logger.log(`registered ${user.email}`);
    return this.issue(user);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    // passwordHash is select:false, so ask for it explicitly.
    const user = await this.users
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.email = :email', { email: dto.email })
      .getOne();

    const ok = await verifyPassword(dto.password, user?.passwordHash ?? null);

    // Same error either way: telling the caller which half was wrong lets them
    // enumerate valid email addresses.
    if (!user || !ok) throw new UnauthorizedException('Invalid email or password');

    return this.issue(user);
  }

  private issue(user: User): AuthResult {
    const accessToken = this.jwt.sign({
      sub: user.id,
      email: user.email,
      name: user.name,
    });

    return {
      accessToken,
      expiresIn: this.expiresIn,
      user: { id: user.id, email: user.email, name: user.name },
    };
  }
}
