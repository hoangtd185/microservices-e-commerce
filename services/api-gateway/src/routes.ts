export interface RouteRule {
  /** Public path prefix exposed to clients. */
  prefix: string;
  /** Internal base URL of the service that owns it. */
  target: string;
  /** What the prefix becomes on the way in. */
  rewrite: string;
  name: string;
}

/**
 * The gateway's routing table - the only place that knows where services live.
 * Clients only ever learn about localhost:3000.
 */
export const ROUTES: RouteRule[] = [
  {
    name: 'user-service',
    prefix: '/api/users',
    target: process.env.USER_SERVICE_URL ?? 'http://localhost:3001',
    rewrite: '/users',
  },
  {
    name: 'order-service',
    prefix: '/api/orders',
    target: process.env.ORDER_SERVICE_URL ?? 'http://localhost:3002',
    rewrite: '/orders',
  },
  {
    name: 'inventory-service',
    prefix: '/api/products',
    target: process.env.INVENTORY_SERVICE_URL ?? 'http://localhost:3003',
    rewrite: '/products',
  },
  {
    name: 'notification-service',
    prefix: '/api/notifications',
    target: process.env.NOTIFICATION_SERVICE_URL ?? 'http://localhost:3004',
    rewrite: '/notifications',
  },
];
