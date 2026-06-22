const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
  const hashedPassword = await bcrypt.hash('Pam@2025!', 10);

  // สร้าง BusinessUnit
  const businessUnit = await prisma.businessUnit.upsert({
    where: { name: 'Default BU' },
    update: {},
    create: { name: 'Default BU' },
  });

  // สร้าง Department
  const department = await prisma.department.upsert({
    where: { name: 'Default Department' },
    update: {},
    create: {
      name: 'Default Department',
      description: 'Default department',
      businessUnitId: businessUnit.id,
    },
  });

  // สร้าง Teamad
  const team = await prisma.team.upsert({
    where: { name: 'Default Team' },
    update: {},
    create: {
      name: 'Default Team',
      departmentId: department.id,
      businessUnitId: businessUnit.id,
    },
  });

  // สร้าง Admin
  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      password: hashedPassword,
      name: 'Admin',
      role: 'admin',
      businessUnitId: businessUnit.id,
      departmentId: department.id,
      teamId: team.id,
    },
  });

  console.log('✅ Admin user created or exists:', admin);
}

main()
  .catch((e) => {
    console.error('❌ Error creating admin:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
