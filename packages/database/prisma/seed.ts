import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // 1) Seed Business Units
  await prisma.businessUnit.createMany({
    data: [
      { id: 27, name: 'DR. HYGIENE MEDICAL PRODUCTS CO., LTD', abbreviation: 'DRHG' },
      { id: 28, name: 'HA CONSTRUCTION CO., LTD', abbreviation: 'HACO' },
      { id: 29, name: 'HYFIRST CO., LTD', abbreviation: 'HFST' },
      { id: 30, name: 'HYLIFE ASSET CO., LTD', abbreviation: 'HLAS' },
      { id: 31, name: 'HYLIFE CONSTRUCTION CO., LTD', abbreviation: 'HCON' },
      { id: 32, name: 'HYLIFE DEVELOPMENTS CO., LTD', abbreviation: 'HDEV' },
      { id: 33, name: 'HYLIFE GLOBAL FOOD CO., LTD', abbreviation: 'HLGF' },
      { id: 35, name: 'HYLIFE IBC CO., LTD', abbreviation: 'HIBC' },
      { id: 37, name: 'HYLIFE PROPERTY SERVICE MANAGEMENT CO., LTD', abbreviation: 'HPSM' }
    ],
    skipDuplicates: true,
  });

  // 2) Seed Departments
  await prisma.department.createMany({
    data: [
      { id: 26, name: 'Executive Office', businessUnitId: null },
      { id: 27, name: 'Corporate Communication', businessUnitId: null },
      { id: 28, name: 'Finance & Accounting', businessUnitId: null },
      { id: 29, name: 'HR & Admin', businessUnitId: null },
      { id: 30, name: 'Software Development', businessUnitId: null },
      { id: 31, name: 'Land Management', businessUnitId: null },
      { id: 32, name: 'Procurement', businessUnitId: null }
    ],
    skipDuplicates: true,
  });

  // 4) Seed Statuses
  await prisma.status.createMany({
    data: [
      { id: 1, name: 'Draft', description: 'Draft' },
      { id: 3, name: 'Approved', description: 'Approved' },
      { id: 4, name: 'Rejected', description: 'Rejected' },
      { id: 5, name: 'Processing', description: 'Pending' },
      { id: 6, name: 'Recalled', description: 'Recalled' },
      { id: 7, name: 'Terminated', description: 'Terminate' }
    ],
    skipDuplicates: true,
  });

  // 5) Seed Users

  await prisma.user.createMany({
    data: [
      { id: 3, name: 'Phichayanit', lastname: 'Saiklaing', email: 'phichayanit.s@hylife.co.th', password: '$2b$10$fjPtvsl0UGu2AlnRK5xaqevF.6Il.Vzx69m/68ejzA.dQTVyQtZvC', role: 'admin', businessUnitId: 35, departmentId: 27, nickname: 'mike', isFirstLogin: false },
      { id: 12, name: 'Sarayut', lastname: 'Inmanee', email: 'sarayut.i@hylife.co.th', password: '$2b$10$br.khX.3R/7Ogq/CszeWKuN4hAS4AdJ4XSIpF4NN5e2EZU0OwJDaK', role: 'admin', businessUnitId: 35, departmentId: 30, nickname: 'boss', isFirstLogin: false },
      { id: 22, name: 'Weerachai', lastname: 'Tamboon', email: 'weerachai.t@hylife.co.th', password: '$2b$10$UfzfJMsEsrcEF5xKDz.WnuFalreIxMe/ngpMS0SESz5M7/RKV1.96', role: 'user', businessUnitId: 35, departmentId: 30, nickname: 'mac', isFirstLogin: false },
      { id: 23, name: 'Kampanat', lastname: 'Kawai', email: 'kampanat.k@hylife.co.th', password: '$2b$10$t842epC2j3gtH.W1gVJGq.7/JLlNUh3n4ezvBwxN9uBSDYXFjK3Sq', role: 'manager', businessUnitId: 35, departmentId: 27, nickname: 'karn', isFirstLogin: false },
      { id: 45, name: 'Suparada', lastname: 'Butbandit', email: 'suparada.b@hylife.co.th', password: '$2b$10$nh/thwtguTPnwoZe2L7hdO1ln03GSa0ZNNSYnr6Z2vtirF4x.Zwh.', role: 'user', businessUnitId: 35, departmentId: 30, nickname: 'pair', isFirstLogin: false }
    ],
    skipDuplicates: true,
  });



  /* ------------------------------------------------------------------ */
  /* ApprovalActionStatus (master lookup)                               */
  /* ------------------------------------------------------------------ */
  const approvalActionStatuses = await Promise.all([
    prisma.approvalActionStatus.upsert({
      where: { id: 1 },
      update: {
        code: 'waiting',
        label: 'Waiting',
        isFinal: false,
        createdAt: new Date('2025-06-13T03:57:22.336Z'),
        updatedAt: new Date('2025-06-13T09:04:42.739Z'),
      },
      create: {
        id: 1,
        code: 'waiting',
        label: 'Waiting',
        isFinal: false,
        createdAt: new Date('2025-06-13T03:57:22.336Z'),
        updatedAt: new Date('2025-06-13T09:04:42.739Z'),
      },
    }),
    prisma.approvalActionStatus.upsert({
      where: { id: 2 },
      update: {
        code: 'approved',
        label: 'Approved',
        isFinal: true,
        createdAt: new Date('2025-06-13T03:57:52.953Z'),
        updatedAt: new Date('2025-06-13T03:57:28.872Z'),
      },
      create: {
        id: 2,
        code: 'approved',
        label: 'Approved',
        isFinal: true,
        createdAt: new Date('2025-06-13T03:57:52.953Z'),
        updatedAt: new Date('2025-06-13T03:57:28.872Z'),
      },
    }),
    prisma.approvalActionStatus.upsert({
      where: { id: 3 },
      update: {
        code: 'rejected',
        label: 'Rejected',
        isFinal: true,
        createdAt: new Date('2025-06-13T03:58:16.562Z'),
        updatedAt: new Date('2025-06-13T03:59:38.724Z'),
      },
      create: {
        id: 3,
        code: 'rejected',
        label: 'Rejected',
        isFinal: true,
        createdAt: new Date('2025-06-13T03:58:16.562Z'),
        updatedAt: new Date('2025-06-13T03:59:38.724Z'),
      },
    }),
    prisma.approvalActionStatus.upsert({
      where: { id: 4 },
      update: {
        code: 'recalled',
        label: 'Recalled',
        isFinal: true,
        createdAt: new Date('2025-06-13T03:59:04.429Z'),
        updatedAt: new Date('2025-06-13T03:59:38.724Z'),
      },
      create: {
        id: 4,
        code: 'recalled',
        label: 'Recalled',
        isFinal: true,
        createdAt: new Date('2025-06-13T03:59:04.429Z'),
        updatedAt: new Date('2025-06-13T03:59:38.724Z'),
      },
    }),
    prisma.approvalActionStatus.upsert({
      where: { id: 5 },
      update: {
        code: 'terminated',
        label: 'Terminated',
        isFinal: true,
        createdAt: new Date('2025-06-13T04:00:02.190Z'),
        updatedAt: new Date('2025-06-13T04:05:30.104Z'),
      },
      create: {
        id: 5,
        code: 'terminated',
        label: 'Terminated',
        isFinal: true,
        createdAt: new Date('2025-06-13T04:00:02.190Z'),
        updatedAt: new Date('2025-06-13T04:05:30.104Z'),
      },
    }),
  ]);
  console.log(`✅ Created ${approvalActionStatuses.length} approval action status records`);

  /* ------------------------------------------------------------------ */
  /* NotificationType                                                    */
  /* ------------------------------------------------------------------ */
  const notificationTypes = await Promise.all([
    prisma.notificationType.upsert({
      where: { id: 1 },
      update: {
        name: 'Wait For Your Turn',
        slug: 'wait-for-your-turn',
        description: 'When the document is waiting for your approval',
        createdAt: new Date('2025-06-11T11:09:29.945Z'),
        updatedAt: new Date('2025-06-11T11:09:29.945Z'),
      },
      create: {
        id: 1,
        name: 'Wait For Your Turn',
        slug: 'wait-for-your-turn',
        description: 'When the document is waiting for your approval',
        createdAt: new Date('2025-06-11T11:09:29.945Z'),
        updatedAt: new Date('2025-06-11T11:09:29.945Z'),
      },
    }),
    prisma.notificationType.upsert({
      where: { id: 2 },
      update: {
        name: 'New Comment',
        slug: 'new-comment',
        description: 'When a new comment is added',
        createdAt: new Date('2025-06-11T11:09:29.945Z'),
        updatedAt: new Date('2025-06-11T11:09:29.945Z'),
      },
      create: {
        id: 2,
        name: 'New Comment',
        slug: 'new-comment',
        description: 'When a new comment is added',
        createdAt: new Date('2025-06-11T11:09:29.945Z'),
        updatedAt: new Date('2025-06-11T11:09:29.945Z'),
      },
    }),
    prisma.notificationType.upsert({
      where: { id: 3 },
      update: {
        name: 'Status Update',
        slug: 'status-update',
        description: 'When the document status is updated',
        createdAt: new Date('2025-06-11T11:09:29.945Z'),
        updatedAt: new Date('2025-06-11T11:09:29.945Z'),
      },
      create: {
        id: 3,
        name: 'Status Update',
        slug: 'status-update',
        description: 'When the document status is updated',
        createdAt: new Date('2025-06-11T11:09:29.945Z'),
        updatedAt: new Date('2025-06-11T11:09:29.945Z'),
      },
    }),
    prisma.notificationType.upsert({
      where: { id: 4 },
      update: {
        name: 'CC Notification',
        slug: 'cc-notification',
        description: 'When you are CC\'d on a memo',
        createdAt: new Date('2026-01-15T12:02:48.104Z'),
        updatedAt: new Date('2026-01-15T12:02:48.104Z'),
      },
      create: {
        id: 4,
        name: 'CC Notification',
        slug: 'cc-notification',
        description: 'When you are CC\'d on a memo',
        createdAt: new Date('2026-01-15T12:02:48.104Z'),
        updatedAt: new Date('2026-01-15T12:02:48.104Z'),
      },
    }),
    prisma.notificationType.upsert({
      where: { id: 5 },
      update: {
        name: 'Tagged in Comment',
        slug: 'tagged-in-comment',
        description: 'When you are mentioned in a comment',
        createdAt: new Date('2026-01-15T12:02:48.104Z'),
        updatedAt: new Date('2026-01-15T12:02:48.104Z'),
      },
      create: {
        id: 5,
        name: 'Tagged in Comment',
        slug: 'tagged-in-comment',
        description: 'When you are mentioned in a comment',
        createdAt: new Date('2026-01-15T12:02:48.104Z'),
        updatedAt: new Date('2026-01-15T12:02:48.104Z'),
      },
    }),
    prisma.notificationType.upsert({
      where: { id: 6 },
      update: {
        name: 'Approved',
        slug: 'status-approved',
        description: 'When the document is approved',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
      create: {
        id: 6,
        name: 'Approved',
        slug: 'status-approved',
        description: 'When the document is approved',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
    }),
    prisma.notificationType.upsert({
      where: { id: 7 },
      update: {
        name: 'Rejected',
        slug: 'status-rejected',
        description: 'When the document is rejected',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
      create: {
        id: 7,
        name: 'Rejected',
        slug: 'status-rejected',
        description: 'When the document is rejected',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
    }),
    prisma.notificationType.upsert({
      where: { id: 8 },
      update: {
        name: 'Terminated',
        slug: 'status-terminated',
        description: 'When the document is terminated',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
      create: {
        id: 8,
        name: 'Terminated',
        slug: 'status-terminated',
        description: 'When the document is terminated',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
    }),
    prisma.notificationType.upsert({
      where: { id: 9 },
      update: {
        name: 'Recalled',
        slug: 'status-recalled',
        description: 'When the document is recalled',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
      create: {
        id: 9,
        name: 'Recalled',
        slug: 'status-recalled',
        description: 'When the document is recalled',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
    }),
    prisma.notificationType.upsert({
      where: { id: 10 },
      update: {
        name: 'Expired',
        slug: 'status-expired',
        description: 'When the document expires',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
      create: {
        id: 10,
        name: 'Expired',
        slug: 'status-expired',
        description: 'When the document expires',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
    }),
    prisma.notificationType.upsert({
      where: { id: 11 },
      update: {
        name: 'Expiry Warning',
        slug: 'near-expiry',
        description: 'When the document is near expiry',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
      create: {
        id: 11,
        name: 'Expiry Warning',
        slug: 'near-expiry',
        description: 'When the document is near expiry',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
    }),
    prisma.notificationType.upsert({
      where: { id: 12 },
      update: {
        name: 'Mentioned other person',
        slug: 'others-mentioned',
        description: 'When someone is mentioned in a memo',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
      create: {
        id: 12,
        name: 'Mentioned other person',
        slug: 'others-mentioned',
        description: 'When someone is mentioned in a memo',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
    }),
    prisma.notificationType.upsert({
      where: { id: 13 },
      update: {
        name: 'Delete mentioned person',
        slug: 'removed-mention',
        description: 'When a mention is removed',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
      create: {
        id: 13,
        name: 'Delete mentioned person',
        slug: 'removed-mention',
        description: 'When a mention is removed',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
    }),
    prisma.notificationType.upsert({
      where: { id: 14 },
      update: {
        name: 'Add  Extra Approval',
        slug: 'add-extra-approval',
        description: 'When an extra approver is added',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
      create: {
        id: 14,
        name: 'Add  Extra Approval',
        slug: 'add-extra-approval',
        description: 'When an extra approver is added',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
    }),
    prisma.notificationType.upsert({
      where: { id: 15 },
      update: {
        name: 'Delete Extra Approval',
        slug: 'remove-extra-approval',
        description: 'When an extra approver is removed',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
      create: {
        id: 15,
        name: 'Delete Extra Approval',
        slug: 'remove-extra-approval',
        description: 'When an extra approver is removed',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
    }),
    prisma.notificationType.upsert({
      where: { id: 16 },
      update: {
        name: 'Approved with condition',
        slug: 'approve-with-condition',
        description: 'When the document is approved with conditions',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
      create: {
        id: 16,
        name: 'Approved with condition',
        slug: 'approve-with-condition',
        description: 'When the document is approved with conditions',
        createdAt: new Date('2026-03-12T00:00:00.000Z'),
        updatedAt: new Date('2026-03-12T00:00:00.000Z'),
      },
    })
  ]);
  console.log(`✅ Created ${notificationTypes.length} notification types`);


  console.log('✅ Seed data created successfully.');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
