import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

export interface Identity {
  userId: string;
  email: string;
  name?: string;
}

/**
 * Token verification lives at the gateway, and the identity it establishes is
 * passed downstream as plain headers. Services never parse a JWT.
 *
 * That is only safe because of two things:
 *   1. services are reachable solely inside the Docker network (in production:
 *      a private subnet or a service mesh with mTLS), and
 *   2. this gateway DELETES any x-user-* header a client tried to send.
 *
 * Skip step 2 and anyone can add `x-user-id: <someone else>` to a request and
 * become that person. It is a one-line mistake with total account takeover as
 * the consequence.
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger('Auth');

  constructor(private readonly jwt: JwtService) {}

  /** Remove client-supplied identity headers before anything else happens. */
  stripSpoofedHeaders(req: Request): void {
    for (const header of Object.keys(req.headers)) {
      if (header.toLowerCase().startsWith('x-user-')) {
        delete req.headers[header];
      }
    }
  }

  verify(req: Request): Identity {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const payload = this.jwt.verify(header.slice('Bearer '.length).trim());
      return { userId: payload.sub, email: payload.email, name: payload.name };
    } catch (err: any) {
      const reason = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
      this.logger.warn(`${reason} for ${req.method} ${req.path}`);
      throw new UnauthorizedException(reason);
    }
  }

  headersFor(identity: Identity): Record<string, string> {
    return {
      'x-user-id': identity.userId,
      'x-user-email': identity.email,
    };
  }
}
