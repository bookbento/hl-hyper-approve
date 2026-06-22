import { prisma } from '../../prisma/client';

/**
 * Get default value for a notification type slug
 * @param slug - The notification type slug (can be null)
 * @returns Default emailEnabled value
 */
function getDefaultPreferenceValue(slug: string | null): boolean {
  if (!slug) return true; // Default to true if slug is null
  
  const defaults: Record<string, boolean> = {
    'wait-for-your-turn': true,
    'new-comment': true,
    'status-approved': true,
    'status-rejected': true,
    'status-terminated': true,
    'status-recalled': true,
    'status-expired': true,
    'near-expiry': true,
    'cc-notification': true,        // Important: know when CC'd
    'tagged-in-comment': true,      // Important: know when mentioned
    'others-mentioned': true,
    'removed-mention': true,
    'add-extra-approval': true,
    'remove-extra-approval': true,
    'approve-with-condition': true,
  };
  return defaults[slug] ?? true; // Default to true for unknown types
}

/**
 * Ensure user has preferences for all notification types (lazy initialization)
 * This is called automatically when preferences are accessed
 * @param userId - The user ID
 */
async function ensureUserPreferences(userId: number): Promise<void> {
  try {
    // Get all notification types
    const types = await prisma.notificationType.findMany();
    
    // Get existing preferences for this user
    const existingPrefs = await prisma.userNotificationPreference.findMany({
      where: { userId },
      select: { notificationTypeId: true }
    });
    
    const existingTypeIds = new Set(existingPrefs.map(p => p.notificationTypeId));
    
    // Find missing preferences
    const missingTypes = types.filter(type => !existingTypeIds.has(type.id));
    
    // Create missing preferences with default values
    if (missingTypes.length > 0) {
      const newPreferences = missingTypes.map(type => ({
        userId,
        notificationTypeId: type.id,
        emailEnabled: getDefaultPreferenceValue(type.slug)
      }));
      
      await prisma.userNotificationPreference.createMany({
        data: newPreferences,
        skipDuplicates: true // Safety check in case of race conditions
      });
      
      console.log(`✅ Auto-created ${missingTypes.length} missing notification preferences for user ${userId}`);
    }
  } catch (error) {
    // Log error but don't throw - we want to continue with default behavior
    console.error('Error ensuring user preferences:', error);
  }
}

/**
 * Check if a user wants to receive email notifications for a specific type
 * @param userId - The user ID to check
 * @param notificationTypeSlug - The notification type slug (e.g., "new-comment")
 * @returns true if email should be sent, false otherwise
 */
export async function shouldSendEmailNotification(
  userId: number,
  notificationTypeSlug: string
): Promise<boolean> {
  try {
    // Get notification type by slug
    const notificationType = await prisma.notificationType.findUnique({
      where: { slug: notificationTypeSlug }
    });

    if (!notificationType) {
      // If type doesn't exist, default to sending (backward compatibility)
      console.warn(`Unknown notification type slug: ${notificationTypeSlug}`);
      return true;
    }

    // Check user preference
    let preference = await prisma.userNotificationPreference.findUnique({
      where: {
        userId_notificationTypeId: {
          userId,
          notificationTypeId: notificationType.id
        }
      }
    });

    // If no preference exists, create it with default value (lazy initialization)
    if (!preference) {
      const defaultValue = getDefaultPreferenceValue(notificationTypeSlug);
      
      try {
        preference = await prisma.userNotificationPreference.create({
          data: {
            userId,
            notificationTypeId: notificationType.id,
            emailEnabled: defaultValue
          }
        });
        console.log(`✅ Auto-created notification preference for user ${userId}, type ${notificationTypeSlug}: ${defaultValue}`);
      } catch (createError) {
        // If creation fails (e.g., race condition), try to fetch again
        preference = await prisma.userNotificationPreference.findUnique({
          where: {
            userId_notificationTypeId: {
              userId,
              notificationTypeId: notificationType.id
            }
          }
        });
      }
    }

    return preference?.emailEnabled ?? getDefaultPreferenceValue(notificationTypeSlug);
  } catch (error) {
    // On error, default to sending email (fail-safe)
    console.error('Error checking notification preference:', error);
    return true;
  }
}

/**
 * Filter users who want to receive email notifications
 * @param userIds - Array of user IDs
 * @param notificationTypeSlug - The notification type slug
 * @returns Array of user IDs who want emails
 */
export async function filterUsersForEmail(
  userIds: number[],
  notificationTypeSlug: string
): Promise<number[]> {
  try {
    if (userIds.length === 0) {
      return [];
    }

    const notificationType = await prisma.notificationType.findUnique({
      where: { slug: notificationTypeSlug }
    });

    if (!notificationType) {
      // If type doesn't exist, default to all users (backward compatibility)
      console.warn(`Unknown notification type slug: ${notificationTypeSlug}`);
      return userIds;
    }

    // Get preferences for users who have disabled this notification type
    const preferences = await prisma.userNotificationPreference.findMany({
      where: {
        userId: { in: userIds },
        notificationTypeId: notificationType.id,
        emailEnabled: false // Only get users who disabled it
      },
      select: { userId: true }
    });

    const disabledUserIds = new Set(preferences.map((p: any) => p.userId));

    // Return users who either have it enabled or have no preference
    return userIds.filter(id => !disabledUserIds.has(id));
  } catch (error) {
    // On error, default to all users (fail-safe)
    console.error('Error filtering users for email:', error);
    return userIds;
  }
}

/**
 * Get all notification preferences for a user
 * Automatically creates missing preferences (lazy initialization)
 * @param userId - The user ID
 * @returns Array of preferences with notification type details
 */
export async function getUserNotificationPreferences(userId: number) {
  try {
    // Ensure user has all preferences (lazy initialization)
    await ensureUserPreferences(userId);
    
    const types = await prisma.notificationType.findMany({
      orderBy: { id: 'asc' }
    });

    const preferences = await prisma.userNotificationPreference.findMany({
      where: { userId },
      include: { notificationType: true }
    });

    // Create map for quick lookup
    const prefMap = new Map(
      preferences.map((p: any) => [p.notificationTypeId, p.emailEnabled])
    );

    // Return all types with their preference status (excluding deprecated 'status-update')
    return types
      .filter((type: any) => type.slug !== 'status-update')
      .map((type: any) => ({
        notificationTypeId: type.id,
        notificationTypeName: type.name,
        notificationTypeSlug: type.slug,
        notificationTypeDescription: type.description,
        emailEnabled: prefMap.get(type.id) ?? getDefaultPreferenceValue(type.slug)
      }));
  } catch (error) {
    console.error('Error getting user notification preferences:', error);
    throw error;
  }
}

/**
 * Update a single notification preference for a user
 * @param userId - The user ID
 * @param notificationTypeId - The notification type ID
 * @param emailEnabled - Whether email notifications should be enabled
 * @returns The updated preference
 */
export async function updateNotificationPreference(
  userId: number,
  notificationTypeId: number,
  emailEnabled: boolean
) {
  try {
    // Verify notification type exists
    const type = await prisma.notificationType.findUnique({
      where: { id: notificationTypeId }
    });

    if (!type) {
      throw new Error('Notification type not found');
    }

    // Upsert preference
    const preference = await prisma.userNotificationPreference.upsert({
      where: {
        userId_notificationTypeId: {
          userId,
          notificationTypeId
        }
      },
      update: { emailEnabled, updatedAt: new Date() },
      create: {
        userId,
        notificationTypeId,
        emailEnabled
      }
    });

    return preference;
  } catch (error) {
    console.error('Error updating notification preference:', error);
    throw error;
  }
}

/**
 * Update all notification preferences for a user (bulk operation)
 * @param userId - The user ID
 * @param emailEnabled - Whether email notifications should be enabled for all types
 * @returns Count of updated preferences
 */
export async function updateAllNotificationPreferences(
  userId: number,
  emailEnabled: boolean
) {
  try {
    const types = await prisma.notificationType.findMany();

    // Create or update preferences for all types
    const operations = types.map((type: any) =>
      prisma.userNotificationPreference.upsert({
        where: {
          userId_notificationTypeId: {
            userId,
            notificationTypeId: type.id
          }
        },
        update: { emailEnabled, updatedAt: new Date() },
        create: {
          userId,
          notificationTypeId: type.id,
          emailEnabled
        }
      })
    );

    await prisma.$transaction(operations);

    return { updatedCount: types.length };
  } catch (error) {
    console.error('Error updating all notification preferences:', error);
    throw error;
  }
}

/**
 * Initialize notification preferences for all users who don't have them
 * Useful for bulk user imports or database migrations
 * @returns Statistics about created preferences
 */
export async function initializeAllUserPreferences() {
  try {
    console.log('🔄 Initializing notification preferences for all users...');
    
    // Get all users
    const users = await prisma.user.findMany({
      select: { id: true }
    });
    
    // Get all notification types
    const types = await prisma.notificationType.findMany();
    
    let totalCreated = 0;
    let usersProcessed = 0;
    
    // Process in batches to avoid overwhelming the database
    const batchSize = 100;
    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);
      
      for (const user of batch) {
        // Get existing preferences
        const existingPrefs = await prisma.userNotificationPreference.findMany({
          where: { userId: user.id },
          select: { notificationTypeId: true }
        });
        
        const existingTypeIds = new Set(existingPrefs.map(p => p.notificationTypeId));
        
        // Find missing preferences
        const missingTypes = types.filter(type => !existingTypeIds.has(type.id));
        
        if (missingTypes.length > 0) {
          const newPreferences = missingTypes.map(type => ({
            userId: user.id,
            notificationTypeId: type.id,
            emailEnabled: getDefaultPreferenceValue(type.slug)
          }));
          
          await prisma.userNotificationPreference.createMany({
            data: newPreferences,
            skipDuplicates: true
          });
          
          totalCreated += missingTypes.length;
        }
        
        usersProcessed++;
      }
      
      console.log(`   Processed ${Math.min(i + batchSize, users.length)}/${users.length} users...`);
    }
    
    console.log(`✅ Initialization complete: Created ${totalCreated} preferences for ${usersProcessed} users`);
    
    return {
      usersProcessed,
      preferencesCreated: totalCreated
    };
  } catch (error) {
    console.error('Error initializing user preferences:', error);
    throw error;
  }
}
