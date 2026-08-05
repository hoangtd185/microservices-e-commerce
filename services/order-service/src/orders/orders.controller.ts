import {
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';

/**
 * x-user-id is set by the gateway after it verified the JWT, and the gateway
 * strips any copy the client tried to send. This service is not reachable from
 * outside the private network, so trusting the header is safe here.
 *
 * (The service ports published in docker-compose are a local debugging
 * convenience. In production you would not expose them.)
 */
function requireCaller(userId: string | undefined): string {
  if (!userId) {
    throw new UnauthorizedException(
      'Missing x-user-id - call through the gateway with a bearer token',
    );
  }
  return userId;
}

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  async create(
    @Body() dto: CreateOrderDto,
    @Headers('x-user-id') callerId: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const userId = requireCaller(callerId);
    const { order, replayed } = await this.orders.create(dto, userId, idempotencyKey);
    if (replayed) {
      res.setHeader('Idempotent-Replay', 'true');
    }
    return order;
  }

  /** Always scoped to the caller - you cannot list someone else's orders. */
  @Get()
  findAll(@Headers('x-user-id') callerId: string | undefined) {
    return this.orders.findAll(requireCaller(callerId));
  }

  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @Headers('x-user-id') callerId: string | undefined,
  ) {
    const userId = requireCaller(callerId);
    const order = await this.orders.findOne(id);

    // Authorisation, not authentication: a valid token proves who you are,
    // not that this particular order is yours. 404 rather than 403 so the
    // response does not confirm that someone else's order id exists.
    if (order.userId !== userId) {
      throw new NotFoundException(`Order ${id} not found`);
    }
    return order;
  }
}
