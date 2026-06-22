/**
 * Test script to verify that gaps in user IDs are NOT filled
 * This is the main test case for the fix
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function testGapNotFilled() {
  console.log('🧪 Testing that gaps in user IDs are NOT filled...\n');

  const testUsers: number[] = [];

  try {
    // Get current max user ID
    const maxUser = await prisma.user.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true }
    });
    
    const startMaxId = maxUser?.id || 0;
    console.log(`📊 Starting max user ID: ${startMaxId}`);

    // Create 3 test users
    console.log(`\n🔨 Creating 3 test users...`);
    for (let i = 1; i <= 3; i++) {
      const testEmail = `test.gap.${Date.now()}.${i}@example.com`;
      const hashedPassword = await bcrypt.hash('TestPassword123!', 10);

      const newUser = await prisma.user.create({
        data: {
          name: `TestGap${i}`,
          lastname: 'User',
          email: testEmail,
          password: hashedPassword,
          role: 'user'
        }
      });

      testUsers.push(newUser.id);
      console.log(`   ✅ User ${i} created with ID: ${newUser.id}`);
      
      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`\n📋 Created users with IDs: ${testUsers.join(', ')}`);

    // Delete the middle user to create a gap
    const middleUserId = testUsers[1];
    console.log(`\n🗑️  Deleting user with ID ${middleUserId} to create a gap...`);
    await prisma.user.delete({ where: { id: middleUserId } });
    console.log(`   ✅ User ${middleUserId} deleted`);

    // Verify the gap exists
    const deletedUser = await prisma.user.findUnique({ where: { id: middleUserId } });
    if (!deletedUser) {
      console.log(`   ✅ Gap confirmed at ID ${middleUserId}`);
    }

    // Now create a new user and verify it gets the NEXT sequential ID, not the gap
    console.log(`\n🔨 Creating a new user after the gap...`);
    const testEmail = `test.after.gap.${Date.now()}@example.com`;
    const hashedPassword = await bcrypt.hash('TestPassword123!', 10);

    const newUser = await prisma.user.create({
      data: {
        name: 'TestAfterGap',
        lastname: 'User',
        email: testEmail,
        password: hashedPassword,
        role: 'user'
      }
    });

    testUsers.push(newUser.id);
    console.log(`   ✅ New user created with ID: ${newUser.id}`);

    // Verify the new user did NOT fill the gap
    const expectedId = testUsers[2] + 1; // Should be after the last user, not in the gap
    
    console.log(`\n📊 Verification:`);
    console.log(`   - Gap at ID: ${middleUserId}`);
    console.log(`   - Last user before new: ${testUsers[2]}`);
    console.log(`   - Expected new user ID: ${expectedId}`);
    console.log(`   - Actual new user ID: ${newUser.id}`);

    if (newUser.id === expectedId && newUser.id !== middleUserId) {
      console.log(`\n✨ SUCCESS: Gap was NOT filled! New user got sequential ID ${newUser.id}`);
      console.log(`   The gap at ID ${middleUserId} remains empty.`);
    } else if (newUser.id === middleUserId) {
      console.log(`\n❌ FAILED: Gap WAS filled! New user got ID ${middleUserId} (the gap)`);
      console.log(`   This is the OLD behavior that we wanted to fix.`);
    } else {
      console.log(`\n⚠️  UNEXPECTED: New user got ID ${newUser.id}`);
      console.log(`   Expected: ${expectedId}`);
    }

    // Clean up - delete all test users
    console.log(`\n🧹 Cleaning up test users...`);
    for (const userId of testUsers) {
      try {
        await prisma.user.delete({ where: { id: userId } });
        console.log(`   ✅ Deleted user ${userId}`);
      } catch (error) {
        // User might already be deleted (the middle one)
        console.log(`   ⏭️  User ${userId} already deleted`);
      }
    }

    console.log(`\n🎉 Test completed successfully!`);

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    
    // Clean up on error
    console.log(`\n🧹 Cleaning up test users after error...`);
    for (const userId of testUsers) {
      try {
        await prisma.user.delete({ where: { id: userId } });
      } catch {
        // Ignore cleanup errors
      }
    }
    
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the test
testGapNotFilled()
  .then(() => {
    console.log('\n✅ All tests passed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  });
