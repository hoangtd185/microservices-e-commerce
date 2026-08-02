import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from './notification.entity';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly repo: Repository<Notification>,
  ) {}

  findAll(userId?: string): Promise<Notification[]> {
    return this.repo.find({
      where: userId ? { userId } : {},
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  /**
   * "Sending" a notification here just means storing it and logging it.
   * Swap this for SendGrid / Twilio / FCM and nothing else in the system
   * has to change - that is the payoff of consuming events instead of
   * being called directly.
   */
  async record(
    topic: string,
    userId: string | null,
    message: string,
    payload: Record<string, any>,
    channel = 'EMAIL',
  ): Promise<void> {
    await this.repo.save(
      this.repo.create({ topic, userId, message, payload, channel }),
    );
    this.logger.log(`[${channel}] ${message}`);
  }
}
