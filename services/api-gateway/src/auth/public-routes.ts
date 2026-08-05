export interface PublicRoute {
  method: string;
  prefix: string;
}

/**
 * Everything under /api requires a valid token EXCEPT these.
 *
 * Deny-by-default is the only safe direction: forget to list a route here and
 * it is merely locked, not exposed. An allow-by-default list has the opposite
 * failure mode, and that is how endpoints end up public by accident.
 */
export const PUBLIC_ROUTES: PublicRoute[] = [
  { method: 'POST', prefix: '/api/auth/register' },
  { method: 'POST', prefix: '/api/auth/login' },
  // Browsing the catalogue does not require an account, same as a real shop.
  { method: 'GET', prefix: '/api/products' },
];

export function isPublic(method: string, path: string): boolean {
  return PUBLIC_ROUTES.some(
    (r) => r.method === method && (path === r.prefix || path.startsWith(`${r.prefix}/`)),
  );
}
