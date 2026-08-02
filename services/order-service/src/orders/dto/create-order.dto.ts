import { IsInt, IsPositive, IsUUID, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateOrderDto {
  @IsUUID()
  userId: string;

  @IsUUID()
  productId: string;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @Max(100)
  quantity: number;
}
