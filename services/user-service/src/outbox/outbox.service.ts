import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OutboxMessage } from './outbox.entity';

export interface OutboxRecord {
  topic: string;
  key?: string | null;
  payload: Record<string, any>;
}

@Injectable()
export class OutboxService {
  /**
   * Append an event to the outbox using the CALLER'S EntityManager, so it
   * joins their open transaction and commits or rolls back with it.
   *
   * Cost inside the transaction: a single INSERT. No network call, no broker
   * round trip - deliberately, because whatever runs inside a transaction
   * holds locks for as long as it takes.
   */
  async record(manager: EntityManager, event: OutboxRecord): Promise<void> {
    await manager.insert(OutboxMessage, {
      topic: event.topic,
      messageKey: event.key ?? null,
      payload: event.payload,
    });
  }

  async recordMany(manager: EntityManager, events: OutboxRecord[]): Promise<void> {
    if (events.length === 0) return;
    await manager.insert(
      OutboxMessage,
      events.map((e) => ({
        topic: e.topic,
        messageKey: e.key ?? null,
        payload: e.payload,
      })),
    );
  }
}
