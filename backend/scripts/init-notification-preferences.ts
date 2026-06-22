/**
 * Utility script to initialize notification preferences for all users
 * Run this after bulk user imports or database migrations
 * 
 * Usage:
 *   npx ts-node scripts/init-notification-preferences.ts
 */

import { initializeAllUserPreferences } from '../src/lib/notificationPreferences';

async function main() {
  console.log('='.repeat(80));
  console.log('NOTIFICATION PREFERENCES INITIALIZATION');
  console.log('='.repeat(80));
  console.log('');
  console.log('This script will create missing notification preferences for all users.');
  console.log('It is safe to run multiple times - existing preferences will not be modified.');
  console.log('');
  
  try {
    const result = await initializeAllUserPreferences();
    
    console.log('');
    console.log('='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log(`Users processed: ${result.usersProcessed}`);
    console.log(`Preferences created: ${result.preferencesCreated}`);
    console.log('');
    console.log('✅ Initialization completed successfully!');
    
    process.exit(0);
  } catch (error) {
    console.error('');
    console.error('='.repeat(80));
    console.error('ERROR');
    console.error('='.repeat(80));
    console.error(error);
    console.error('');
    console.error('❌ Initialization failed!');
    
    process.exit(1);
  }
}

main();
