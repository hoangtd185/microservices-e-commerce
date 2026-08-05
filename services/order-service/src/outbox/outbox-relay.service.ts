import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { DataSource } from 'typeorm';
import { KAFKA_PRODUCER } from '../kafka/kafka.module';

interface ClaimedRow {
  id: number;
  topic: string;
  messageKey: string | null;
  payload: Record<string, any>;
}

const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_MS ?? 500);
const BATCH_SIZE = Number(process.env.OUTBOX_BATCH ?? 100);
/** How long a claim is honoured before another relay may retry the row. */
const LEASE_SECONDS = Number(process.env.OUTBOX_LEASE_SECONDS ?? 30);

/**
 * Reads the outbox and publishes to Kafka.
 *
 * Runs in-process here to keep the stack small. Production usually replaces
 * this with change-data-capture (Debezium tailing the Postgres WAL), which
 * removes the polling entirely - but the contract is identical, so the
 * business code never has to change.
 *
 * Transaction discipline: claiming is ONE statement, publishing happens with
 * no transaction open at all, and marking done is ONE statement. Nothing slow
 * ever runs inside a transaction.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly dataSource: DataSource,
    @Inject(KAFKA_PRODUCER) private readonly kafka: ClientKafka,
  ) {}

  async onApplicationBootstrap() {
    await this.kafka.connect();
    this.schedule();
    this.logger.log(`outbox relay started (every ${POLL_INTERVAL_MS}ms, batch ${BATCH_SIZE})`);
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule() {
    if (this.stopped) return;
    // setTimeout rather than setInterval: a slow tick must never overlap itself.
    this.timer = setTimeout(() => void this.tick(), POLL_INTERVAL_MS);
  }

  private async tick() {
    if (this.running || this.stopped) return this.schedule();
    this.running = true;
    try {
      let drained = false;
      // Keep going while there is a full batch waiting, so a backlog clears
      // fast instead of one batch per poll interval.
      while (!drained && !this.stopped) {
        const published = await this.publishBatch();
        drained = published < BATCH_SIZE;
      }
    } catch (err: any) {
      this.logger.error(`outbox relay error: ${err.message}`);
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  private async publishBatch(): Promise<number> {
    // --- statement 1: claim. Single statement = shortest possible lock. ---
    // SKIP LOCKED lets several relay instances work the same table without
    // blocking each other or handing out the same row twice.
    const claimed: ClaimedRow[] = await this.dataSource.query(
      `WITH claimed AS (
         UPDATE outbox
            SET "claimedAt" = now(), attempts = attempts + 1
          WHERE id IN (
            SELECT id FROM outbox
             WHERE "publishedAt" IS NULL
               AND ("claimedAt" IS NULL OR "claimedAt" < now() - ($2 || ' seconds')::interval)
             ORDER BY id
             LIMIT $1
             FOR UPDATE SKIP LOCKED
          )
         RETURNING id, topic, "messageKey", payload
       )
       SELECT * FROM claimed ORDER BY id`,
      [BATCH_SIZE, String(LEASE_SECONDS)],
    );

    if (claimed.length === 0) return 0;

    // --- publish with NO transaction open ---
    // Sequential on purpose: rows are ordered by id, and publishing them in
    // that order preserves per-key ordering on the topic.
    const sent: number[] = [];
    for (const row of claimed) {
      try {
        await firstValueFrom(
          this.kafka.emit(row.topic, { key: row.messageKey, value: row.payload }),
        );
        sent.push(row.id);
      } catch (err: any) {
        // Leave it claimed; the lease expires and another pass retries it.
        this.logger.warn(`outbox ${row.id} (${row.topic}) failed: ${err.message}`);
        await this.dataSource.query(
          `UPDATE outbox SET "lastError" = $2 WHERE id = $1`,
          [row.id, String(err.message).slice(0, 500)],
        );
        break; // stop the batch so ordering is not broken by skipping ahead
      }
    }

    // --- statement 2: mark done. Also one statement. ---
    if (sent.length > 0) {
      await this.dataSource.query(
        `UPDATE outbox SET "publishedAt" = now(), "lastError" = NULL WHERE id = ANY($1)`,
        [sent],
      );
      this.logger.debug?.(`published ${sent.length} outbox message(s)`);
    }

    return sent.length;
  }

  /** Exposed for the health endpoint: how far behind is the relay? */
  async pendingCount(): Promise<number> {
    const [row] = await this.dataSource.query(
      `SELECT count(*)::int AS pending FROM outbox WHERE "publishedAt" IS NULL`,
    );
    return row?.pending ?? 0;
  }
}
