import { test, expect, Page } from '@playwright/test';

/**
 * E2E Tests for Extra Approver Comment Feature
 * 
 * These tests simulate real user interactions from browser
 * 
 * Setup required:
 * 1. Backend server running on http://localhost:3000
 * 2. Frontend running on http://localhost:5173
 * 3. Test database with seed data
 */

test.describe('Extra Approver Comment - E2E Tests', () => {
  let page: Page;

  test.beforeEach(async ({ page: testPage }) => {
    page = testPage;
    
    // Login
    await page.goto('http://localhost:5173/login');
    await page.fill('input[name="username"]', 'weerachai.t@hylife.co.th');
    await page.fill('input[name="password"]', 'Hylife@2027');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard');
  });

  test('should display comment textarea in confirmation dialog', async () => {
    // Navigate to memo viewer
    await page.goto('http://localhost:5173/memo/1141');
    await page.waitForLoadState('networkidle');

    // Click Add Extra Approval button
    await page.click('[title*="Add Extra Approval"]');

    // Search for user
    await page.fill('input[placeholder*="search"]', 'Weerachai');
    await page.waitForTimeout(500);

    // Select user
    await page.click('text=Weerachai');

    // Verify confirmation dialog appears
    await expect(page.locator('text=Confirm Action')).toBeVisible();

    // Verify comment textarea exists
    const textarea = page.locator('textarea[placeholder*="reason"]');
    await expect(textarea).toBeVisible();

    // Verify character counter
    await expect(page.locator('text=0/500')).toBeVisible();
  });

  test('should update character counter as user types', async () => {
    // ... navigate to dialog ...
    await page.goto('http://localhost:5173/memo/1141');
    await page.click('[title*="Add Extra Approval"]');
    await page.fill('input[placeholder*="search"]', 'Weerachai');
    await page.waitForTimeout(500);
    await page.click('text=Weerachai');

    // Type in textarea
    const textarea = page.locator('textarea[placeholder*="reason"]');
    const testComment = 'Need urgent approval for budget increase';
    await textarea.fill(testComment);

    // Verify character counter updates
    await expect(page.locator(`text=${testComment.length}/500`)).toBeVisible();
  });

  test('should enforce 500 character limit', async () => {
    // ... navigate to dialog ...
    await page.goto('http://localhost:5173/memo/1141');
    await page.click('[title*="Add Extra Approval"]');
    await page.fill('input[placeholder*="search"]', 'Weerachai');
    await page.waitForTimeout(500);
    await page.click('text=Weerachai');

    // Try to type more than 500 characters
    const textarea = page.locator('textarea[placeholder*="reason"]');
    const longText = 'a'.repeat(600);
    await textarea.fill(longText);

    // Verify only 500 characters are accepted
    const value = await textarea.inputValue();
    expect(value.length).toBeLessThanOrEqual(500);
  });

  test('should create extra approval line with comment', async () => {
    // Navigate and open dialog
    await page.goto('http://localhost:5173/memo/1141');
    await page.click('[title*="Add Extra Approval"]');
    await page.fill('input[placeholder*="search"]', 'Weerachai');
    await page.waitForTimeout(500);
    await page.click('text=Weerachai');

    // Enter comment
    const testComment = 'E2E test comment - urgent approval needed';
    await page.fill('textarea[placeholder*="reason"]', testComment);

    // Intercept API request
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/extra-approval-lines') &&
        response.request().method() === 'POST'
    );

    // Click Confirm
    await page.click('button:has-text("Confirm")');

    // Wait for API response
    const response = await responsePromise;
    const responseData = await response.json();

    // Verify response includes commentId
    expect(responseData.commentId).toBeDefined();
    expect(responseData.comment).toBeDefined();
    expect(responseData.comment.comment).toBe(testComment);

    // Verify success toast
    await expect(page.locator('text=สร้าง Extra line แล้ว')).toBeVisible();
  });

  test('should display comment in extra approval card', async () => {
    const testComment = 'E2E test - verify display';

    // Create extra line with comment
    await page.goto('http://localhost:5173/memo/1141');
    await page.click('[title*="Add Extra Approval"]');
    await page.fill('input[placeholder*="search"]', 'Weerachai');
    await page.waitForTimeout(500);
    await page.click('text=Weerachai');
    await page.fill('textarea[placeholder*="reason"]', testComment);
    await page.click('button:has-text("Confirm")');

    // Wait for card to appear
    await page.waitForTimeout(1000);

    // Verify comment is displayed in the card
    await expect(page.locator(`text=${testComment}`)).toBeVisible();

    // Verify comment section has correct styling
    const commentSection = page.locator('.bg-blue-50').filter({ hasText: testComment });
    await expect(commentSection).toBeVisible();

    // Verify label is present
    await expect(page.locator('text=Comment / Reason')).toBeVisible();
  });

  test('should work without comment (optional field)', async () => {
    // Navigate and open dialog
    await page.goto('http://localhost:5173/memo/1141');
    await page.click('[title*="Add Extra Approval"]');
    await page.fill('input[placeholder*="search"]', 'Weerachai');
    await page.waitForTimeout(500);
    await page.click('text=Weerachai');

    // Leave comment empty and confirm
    await page.click('button:has-text("Confirm")');

    // Verify success
    await expect(page.locator('text=สร้าง Extra line แล้ว')).toBeVisible();

    // Verify no comment section appears in card
    await page.waitForTimeout(1000);
    const commentSection = page.locator('.bg-blue-50');
    await expect(commentSection).not.toBeVisible();
  });

  test('should clear comment when dialog is cancelled', async () => {
    // Open dialog and enter comment
    await page.goto('http://localhost:5173/memo/1141');
    await page.click('[title*="Add Extra Approval"]');
    await page.fill('input[placeholder*="search"]', 'Weerachai');
    await page.waitForTimeout(500);
    await page.click('text=Weerachai');
    await page.fill('textarea[placeholder*="reason"]', 'Test comment');

    // Cancel dialog
    await page.click('button:has-text("Cancel")');

    // Reopen dialog
    await page.click('[title*="Add Extra Approval"]');
    await page.fill('input[placeholder*="search"]', 'Weerachai');
    await page.waitForTimeout(500);
    await page.click('text=Weerachai');

    // Verify textarea is empty
    const textarea = page.locator('textarea[placeholder*="reason"]');
    const value = await textarea.inputValue();
    expect(value).toBe('');
  });

  test('should display comment in modal view', async () => {
    const testComment = 'Modal view test comment';

    // Create extra line with comment
    await page.goto('http://localhost:5173/memo/1141');
    await page.click('[title*="Add Extra Approval"]');
    await page.fill('input[placeholder*="search"]', 'Weerachai');
    await page.waitForTimeout(500);
    await page.click('text=Weerachai');
    await page.fill('textarea[placeholder*="reason"]', testComment);
    await page.click('button:has-text("Confirm")');
    await page.waitForTimeout(1000);

    // Open chat modal
    await page.click('[title="Expand chat"]');

    // Verify comment is visible in modal
    await expect(page.locator(`text=${testComment}`)).toBeVisible();
  });

  test('should support Thai language', async () => {
    // Switch to Thai language
    await page.goto('http://localhost:5173/memo/1141');
    // ... language switch logic ...

    // Open dialog
    await page.click('[title*="Add Extra Approval"]');
    await page.fill('input[placeholder*="search"]', 'Weerachai');
    await page.waitForTimeout(500);
    await page.click('text=Weerachai');

    // Verify Thai labels
    await expect(page.locator('text=ความคิดเห็น / เหตุผล')).toBeVisible();
    await expect(page.locator('textarea[placeholder*="ระบุเหตุผล"]')).toBeVisible();
  });
});
