import { IsInt, IsPositive, IsUUID, Max } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Note what is NOT here: userId.
 *
 * It used to be part of the body, which meant any caller could place an order
 * on behalf of anybody. The identity now comes from the verified JWT, via the
 * x-user-id header the gateway sets. A field the client controls can never be
 * an identity.
 */
export class CreateOrderDto {
  @IsUUID()
  productId: string;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @Max(100)
  quantity: number;
}
