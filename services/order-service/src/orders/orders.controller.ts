import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * Idempotency-Key is optional but strongly recommended: without it, a client
   * that retries on timeout can create two orders for one purchase.
   * Convention follows Stripe's - client-generated, unique per logical request.
   */
  @Post()
  async create(
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { order, replayed } = await this.orders.create(dto, idempotencyKey);
    if (replayed) {
      res.setHeader('Idempotent-Replay', 'true');
    }
    return order;
  }

  @Get()
  findAll(@Query('userId') userId?: string) {
    return this.orders.findAll(userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.orders.findOne(id);
  }
}
