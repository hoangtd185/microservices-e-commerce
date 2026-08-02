import { IsInt, IsNumber, IsPositive, IsString, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProductDto {
  @IsString()
  @MinLength(2)
  sku: string;

  @IsString()
  @MinLength(2)
  name: string;

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  price: number;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  stock: number;
}

export class RestockDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  quantity: number;
}
