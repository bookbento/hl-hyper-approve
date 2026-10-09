import { PrismaClient } from '@hl/database';

/**
 * DI token + type for the shared Prisma client.
 *
 * Never instantiated: PrismaModule binds this token to the `prisma` singleton
 * exported by @hl/database, so Nest and the legacy backend code it still loads
 * (e.g. memoSearch.service) share one connection pool instead of opening two.
 *
 * Injection sites keep using `PrismaService` exactly as before.
 */
export abstract class PrismaService extends PrismaClient {}
