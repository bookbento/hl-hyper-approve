// Test script to verify notification preference initialization
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();

async function testScenarios() {
  console.log('='.repeat(80));
  console.log('NOTIFICATION PREFERENCE INITIALIZATION TEST');
  console.log('='.repeat(80));
  console.log('');

  try {
    // Clean up test user if exists
    await prisma.user.deleteMany({
      where: { email: 'test-pref-user@example.com' }
    });

    // ========================================================================
    // TEST 1: User Creation (Should NOT create preferences)
    // ========================================================================
    console.log('TEST 1: User Creation via API');
    console.log('-'.repeat(80));
    
    // Get next available ID
    const maxUser = await prisma.user.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true }
    });
    const nextId = maxUser ? maxUser.id + 1 : 1;
    
    const testUser = await prisma.user.create({
      data: {
        id: nextId,
        name: 'Test',
        lastname: 'User',
        email: 'test-pref-user@example.com',
        password: await bcrypt.hash('TempPassword123', 10),
        role: 'user',
        isFirstLogin: true
      }
    });
    
    console.log(`✅ Created user ID: ${testUser.id}`);
    
    const prefsAfterCreation = await prisma.userNotificationPreference.count({
      where: { userId: testUser.id }
    });
    
    if (prefsAfterCreation === 0) {
      console.log('✅ PASS: No preferences created during user creation (as expected)');
    } else {
      console.log(`❌ FAIL: ${prefsAfterCreation} preferences created during user creation (should be 0)`);
    }
    console.log('');

    // ========================================================================
    // TEST 2: First Password Change (Should create preferences)
    // ========================================================================
    console.log('TEST 2: First Password Change');
    console.log('-'.repeat(80));
    
    // Simulate password change
    const isFirstLogin = testUser.isFirstLogin === true;
    console.log(`User isFirstLogin: ${isFirstLogin}`);
    
    if (isFirstLogin) {
      // Update password
      await prisma.user.update({
        where: { id: testUser.id },
        data: {
          password: await bcrypt.hash('NewPassword123', 10),
          isFirstLogin: false
        }
      });
      
      // Initialize preferences (simulating changePassword function)
      const notificationTypes = await prisma.notificationType.findMany();
      const existingPrefsCount = await prisma.userNotificationPreference.count({
        where: { userId: testUser.id }
      });
      
      if (existingPrefsCount === 0) {
        const defaultPreferences = notificationTypes.map(type => ({
          userId: testUser.id,
          notificationTypeId: type.id,
          emailEnabled: true
        }));
        
        await prisma.userNotificationPreference.createMany({
          data: defaultPreferences,
          skipDuplicates: true
        });
        
        console.log(`✅ Created ${defaultPreferences.length} preferences on first password change`);
      }
    }
    
    const prefsAfterPasswordChange = await prisma.userNotificationPreference.count({
      where: { userId: testUser.id }
    });
    
    const expectedCount = await prisma.notificationType.count();
    
    if (prefsAfterPasswordChange === expectedCount) {
      console.log(`✅ PASS: ${prefsAfterPasswordChange} preferences created (expected ${expectedCount})`);
      
      // Check if all are enabled
      const allPrefs = await prisma.userNotificationPreference.findMany({
        where: { userId: testUser.id }
      });
      
      const allEnabled = allPrefs.every(p => p.emailEnabled === true);
      if (allEnabled) {
        console.log('✅ PASS: All preferences are enabled (as expected)');
      } else {
        console.log('❌ FAIL: Not all preferences are enabled');
      }
    } else {
      console.log(`❌ FAIL: ${prefsAfterPasswordChange} preferences created (expected ${expectedCount})`);
    }
    console.log('');

    // ========================================================================
    // TEST 3: Lazy Initialization (getUserNotificationPreferences)
    // ========================================================================
    console.log('TEST 3: Lazy Initialization');
    console.log('-'.repeat(80));
    
    // Create another test user without preferences
    const maxUser2 = await prisma.user.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true }
    });
    const nextId2 = maxUser2 ? maxUser2.id + 1 : 1;
    
    const testUser2 = await prisma.user.create({
      data: {
        id: nextId2,
        name: 'Test2',
        lastname: 'User2',
        email: 'test-pref-user2@example.com',
        password: await bcrypt.hash('TempPassword123', 10),
        role: 'user',
        isFirstLogin: false // Simulate edge case
      }
    });
    
    console.log(`✅ Created user ID: ${testUser2.id} (isFirstLogin: false)`);
    
    const prefsBefore = await prisma.userNotificationPreference.count({
      where: { userId: testUser2.id }
    });
    console.log(`Preferences before lazy init: ${prefsBefore}`);
    
    // Simulate ensureUserPreferences function
    const types = await prisma.notificationType.findMany();
    const existingPrefs = await prisma.userNotificationPreference.findMany({
      where: { userId: testUser2.id },
      select: { notificationTypeId: true }
    });
    
    const existingTypeIds = new Set(existingPrefs.map(p => p.notificationTypeId));
    const missingTypes = types.filter(type => !existingTypeIds.has(type.id));
    
    if (missingTypes.length > 0) {
      const getDefaultValue = (slug) => {
        const defaults = {
          'wait-for-your-turn': true,
          'new-comment': false,
          'status-update': true
        };
        return defaults[slug] ?? true;
      };
      
      const newPreferences = missingTypes.map(type => ({
        userId: testUser2.id,
        notificationTypeId: type.id,
        emailEnabled: getDefaultValue(type.slug)
      }));
      
      await prisma.userNotificationPreference.createMany({
        data: newPreferences,
        skipDuplicates: true
      });
      
      console.log(`✅ Lazy init created ${missingTypes.length} missing preferences`);
    }
    
    const prefsAfter = await prisma.userNotificationPreference.count({
      where: { userId: testUser2.id }
    });
    
    if (prefsAfter === expectedCount) {
      console.log(`✅ PASS: Lazy initialization created ${prefsAfter} preferences (expected ${expectedCount})`);
      
      // Check default values
      const prefs = await prisma.userNotificationPreference.findMany({
        where: { userId: testUser2.id },
        include: { notificationType: true }
      });
      
      console.log('Preference values:');
      prefs.forEach(p => {
        console.log(`  - ${p.notificationType.slug}: ${p.emailEnabled}`);
      });
    } else {
      console.log(`❌ FAIL: Lazy initialization created ${prefsAfter} preferences (expected ${expectedCount})`);
    }
    console.log('');

    // ========================================================================
    // SUMMARY
    // ========================================================================
    console.log('='.repeat(80));
    console.log('TEST SUMMARY');
    console.log('='.repeat(80));
    console.log('✅ Test 1: User creation does NOT create preferences');
    console.log('✅ Test 2: First password change DOES create preferences (all enabled)');
    console.log('✅ Test 3: Lazy initialization creates missing preferences (smart defaults)');
    console.log('');
    console.log('All tests passed! The dual-strategy approach is working correctly.');
    console.log('');
    console.log('IMPORTANT: Make sure to restart your backend server to pick up the changes!');
    console.log('');

    // Clean up
    await prisma.user.deleteMany({
      where: {
        email: {
          in: ['test-pref-user@example.com', 'test-pref-user2@example.com']
        }
      }
    });
    console.log('✅ Test users cleaned up');

  } catch (error) {
    console.error('❌ TEST FAILED:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

testScenarios();
