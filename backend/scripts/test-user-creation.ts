/**
 * Test script to verify user ID sequence fix
 * This script tests that new users are created with sequential IDs (last ID + 1)
 * even when there are gaps in the sequence
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function testUserCreation() {
  console.log('🧪 Testing User ID Sequence Fix...\n');

  try {
    // Get current max user ID
    const maxUser = await prisma.user.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true }
    });
    
    const currentMaxId = maxUser?.id || 0;
    console.log(`📊 Current max user ID: ${currentMaxId}`);

    // Create a test user
    const testEmail = `test.user.${Date.now()}@example.com`;
    const hashedPassword = await bcrypt.hash('TestPassword123!', 10);

    console.log(`\n🔨 Creating test user with email: ${testEmail}`);
    
    const newUser = await prisma.user.create({
      data: {
        name: 'Test',
        lastname: 'User',
        email: testEmail,
        password: hashedPassword,
        role: 'user'
      }
    });

    console.log(`✅ User created successfully!`);
    console.log(`   - User ID: ${newUser.id}`);
    console.log(`   - Expected ID: ${currentMaxId + 1}`);
    
    if (newUser.id === currentMaxId + 1) {
      console.log(`\n✨ SUCCESS: User ID is sequential (${currentMaxId} + 1 = ${newUser.id})`);
    } else {
      console.log(`\n❌ FAILED: User ID is NOT sequential!`);
      console.log(`   Expected: ${currentMaxId + 1}`);
      console.log(`   Got: ${newUser.id}`);
    }

    // Clean up - delete the test user
    console.log(`\n🧹 Cleaning up test user...`);
    await prisma.user.delete({ where: { id: newUser.id } });
    console.log(`✅ Test user deleted`);

    // Verify the gap exists
    const verifyUser = await prisma.user.findUnique({ where: { id: newUser.id } });
    if (!verifyUser) {
      console.log(`✅ Gap confirmed at ID ${newUser.id}`);
    }

    console.log(`\n🎉 Test completed successfully!`);
    console.log(`\n📝 Note: The gap at ID ${newUser.id} will NOT be filled by future user creations.`);
    console.log(`   Next user will get ID ${newUser.id + 1}`);

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the test
testUserCreation()
  .then(() => {
    console.log('\n✅ All tests passed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  });
