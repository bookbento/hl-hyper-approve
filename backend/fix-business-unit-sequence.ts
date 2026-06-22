// Run this script to fix the BusinessUnit ID sequence
// Usage: npx ts-node fix-business-unit-sequence.ts

import { prisma } from './prisma/client';

async function fixSequence() {
  try {
    console.log('🔧 Fixing BusinessUnit ID sequence...');
    
    // Get the maximum ID currently in the table
    const maxRecord = await prisma.businessUnit.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true }
    });

    if (!maxRecord) {
      console.log('ℹ️  No records found in BusinessUnit table. Sequence is fine.');
      return;
    }

    const maxId = maxRecord.id;
    console.log(`📊 Current max ID: ${maxId}`);

    // Reset the sequence to max ID + 1
    // This works for PostgreSQL
    await prisma.$executeRawUnsafe(
      `ALTER SEQUENCE "BusinessUnit_id_seq" RESTART WITH ${maxId + 1}`
    );

    console.log(`✅ Sequence reset to ${maxId + 1}`);
    console.log('✅ BusinessUnit ID sequence fixed successfully!');
    
  } catch (error: any) {
    console.error('❌ Error fixing sequence:', error.message);
    
    // If PostgreSQL sequence command fails, try MySQL/MariaDB approach
    if (error.message.includes('syntax error') || error.message.includes('SEQUENCE')) {
      console.log('🔄 Trying MySQL/MariaDB approach...');
      try {
        const maxRecord = await prisma.businessUnit.findFirst({
          orderBy: { id: 'desc' },
          select: { id: true }
        });
        
        if (maxRecord) {
          await prisma.$executeRawUnsafe(
            `ALTER TABLE BusinessUnit AUTO_INCREMENT = ${maxRecord.id + 1}`
          );
          console.log(`✅ AUTO_INCREMENT reset to ${maxRecord.id + 1}`);
        }
      } catch (mysqlError: any) {
        console.error('❌ MySQL approach also failed:', mysqlError.message);
        console.log('\n📝 Please run this SQL manually in your database:');
        console.log(`   SELECT MAX(id) FROM BusinessUnit;`);
        console.log(`   -- Then run one of these based on your database:`);
        console.log(`   -- PostgreSQL: ALTER SEQUENCE "BusinessUnit_id_seq" RESTART WITH <max_id + 1>;`);
        console.log(`   -- MySQL: ALTER TABLE BusinessUnit AUTO_INCREMENT = <max_id + 1>;`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

fixSequence();
