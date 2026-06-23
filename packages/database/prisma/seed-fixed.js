const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

console.log('Starting seed script...');

// Create a new PrismaClient instance with explicit options
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

// Enable query logging
prisma.$on('query', (e) => {
  console.log('Query: ' + e.query);
  console.log('Params: ' + e.params);
  console.log('Duration: ' + e.duration + 'ms');
});

async function main() {
  console.log('Main function started...');
  
  // Hash password for users
  const saltRounds = 10;
  const defaultPassword = await bcrypt.hash('password123', saltRounds);
  
  // Create BusinessUnits
  const businessUnits = await Promise.all([
    prisma.businessUnit.upsert({
      where: { name: 'Headquarters' },
      update: {},
      create: { 
        name: 'Headquarters', 
        abbreviation: 'HQ' 
      },
    }),
    prisma.businessUnit.upsert({
      where: { name: 'Research & Development' },
      update: {},
      create: { 
        name: 'Research & Development', 
        abbreviation: 'R&D' 
      },
    }),
    prisma.businessUnit.upsert({
      where: { name: 'Sales & Marketing' },
      update: {},
      create: { 
        name: 'Sales & Marketing', 
        abbreviation: 'S&M' 
      },
    }),
    prisma.businessUnit.upsert({
      where: { name: 'Operations' },
      update: {},
      create: { 
        name: 'Operations', 
        abbreviation: 'OPS' 
      },
    }),
  ]);

  console.log(`✅ Created ${businessUnits.length} business units`);

  // Create at least one department
  const department = await prisma.department.upsert({
    where: { name: 'Executive Office' },
    update: {},
    create: {
      name: 'Executive Office',
      description: 'Executive leadership and management',
      businessUnitId: businessUnits[0].id,
    },
  });

  console.log(`✅ Created department: ${department.name}`);

  // Create at least one team
  const team = await prisma.team.upsert({
    where: { name: 'Executive Team' },
    update: {},
    create: {
      name: 'Executive Team',
      businessUnitId: businessUnits[0].id,
      departmentId: department.id,
    },
  });

  console.log(`✅ Created team: ${team.name}`);

  // Create admin user
  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      password: defaultPassword,
      name: 'Admin User',
      role: 'admin',
      businessUnitId: businessUnits[0].id,
      departmentId: department.id,
      teamId: team.id,
    },
  });

  console.log(`✅ Created admin user: ${admin.email}`);
}

console.log('Executing main function...');

main()
  .then(() => {
    console.log('✅ Seed completed successfully!');
  })
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    console.log('Disconnecting from database...');
    await prisma.$disconnect();
    console.log('Disconnected from database.');
  });
