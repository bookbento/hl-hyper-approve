/**
 * Create the missing UserNotificationPreference rows (emailEnabled = true) for
 * every user × notification type. Safe to re-run: existing rows are untouched.
 * Run after bulk user imports or after adding a notification type.
 *
 *   DATABASE_URL=… pnpm --filter @hl/database db:init-preferences
 *
 * Moved from backend/scripts/init-notification-preferences.ts (every default was true).
 */
import { prisma } from '../src';

async function main() {
  const [users, types] = await Promise.all([
    prisma.user.findMany({ select: { id: true }, orderBy: { id: 'asc' } }),
    prisma.notificationType.findMany({ select: { id: true } }),
  ]);

  let created = 0;
  const batchSize = 100;
  for (let i = 0; i < users.length; i += batchSize) {
    const data = users
      .slice(i, i + batchSize)
      .flatMap((u) => types.map((t) => ({ userId: u.id, notificationTypeId: t.id, emailEnabled: true })));
    const res = await prisma.userNotificationPreference.createMany({ data, skipDuplicates: true });
    created += res.count;
    console.log(`processed ${Math.min(i + batchSize, users.length)}/${users.length} users`);
  }
  console.log(`done: ${created} preferences created for ${users.length} users × ${types.length} types`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
