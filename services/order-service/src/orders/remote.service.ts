import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

interface RemoteUser {
  id: string;
  email: string;
  name: string;
}

interface RemoteProduct {
  id: string;
  sku: string;
  name: string;
  price: number;
  stock: number;
}

/**
 * Synchronous, request/response calls to other services.
 *
 * Why not Kafka here? Because the caller is standing at the checkout waiting
 * for an answer. Kafka is for "this happened, react whenever you can";
 * HTTP is for "I need this value right now".
 */
@Injectable()
export class RemoteService {
  private readonly logger = new Logger(RemoteService.name);
  private readonly userUrl = process.env.USER_SERVICE_URL ?? 'http://localhost:3001';
  private readonly inventoryUrl =
    process.env.INVENTORY_SERVICE_URL ?? 'http://localhost:3003';

  constructor(private readonly http: HttpService) {}

  async getUser(userId: string): Promise<RemoteUser> {
    try {
      const res = await firstValueFrom(
        this.http.get<RemoteUser>(`${this.userUrl}/users/${userId}`, { timeout: 5000 }),
      );
      return res.data;
    } catch (err: any) {
      this.logger.warn(`user lookup failed for ${userId}: ${err.message}`);
      throw new BadRequestException(`User ${userId} does not exist`);
    }
  }

  async getProduct(productId: string): Promise<RemoteProduct> {
    try {
      const res = await firstValueFrom(
        this.http.get<RemoteProduct>(`${this.inventoryUrl}/products/${productId}`, {
          timeout: 5000,
        }),
      );
      return res.data;
    } catch (err: any) {
      this.logger.warn(`product lookup failed for ${productId}: ${err.message}`);
      throw new BadRequestException(`Product ${productId} does not exist`);
    }
  }
}
