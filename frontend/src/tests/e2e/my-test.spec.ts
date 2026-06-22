
import { test } from '@playwright/test';

test.describe('Upload test', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only');

  test('test', async ({ page }) => {
    await page.goto('http://localhost:5173/login?redirect=/');
    await page.getByRole('textbox', { name: 'Enter your email' }).click();
    await page.getByRole('textbox', { name: 'Enter your email' }).fill('weerachai.t@hylife.co.th');
    await page.getByRole('textbox', { name: 'Enter your password' }).click();
    await page.getByRole('textbox', { name: 'Enter your password' }).fill('Hylife@2027');
    await page.getByRole('button', { name: 'Log In' }).click();
    await page.waitForTimeout(2000);
    await page.goto('http://localhost:5173/memos/new?typeId=956');
    await page.getByRole('textbox', { name: 'Enter the title of your' }).fill('Test');
    
    // Set the file on the specific PDF file input
    const fileInput = page.locator('input[type="file"]#pdfFile');
    await fileInput.setInputFiles('C:\\Users\\werac\\Downloads\\file-sample_150kB.pdf');
    
    await page.getByRole('button', { name: 'Next', exact: true }).click();


    await page.getByRole('button', { name: 'Select User' }).first().click();
    await page.getByRole('textbox', { name: 'Type a name/email (min 2' }).fill('weera');
    await page.getByText('Software Development').click();
    await page.getByRole('button', { name: 'Select User (1)' }).click();

    await page.getByRole('button', { name: 'Select User' }).click();
    await page.getByRole('textbox', { name: 'Type a name/email (min 2' }).fill('weera');
    await page.getByRole('dialog').getByText('weerachai.t@hylife.co.th').click();
    await page.getByRole('button', { name: 'Select User (1)' }).click();


    await page.getByRole('button', { name: '+ Add Signature & Date' }).first().click();
    await page.locator('.react-pdf__Page').click();
    await page.getByRole('button', { name: '+ Add Signature & Date' }).nth(1).click();
    await page.locator('.react-pdf__Page').click();
    await page.getByRole('button', { name: '+ Add Signature & Date', exact: true }).click();
    await page.locator('.react-pdf__Page').click();
    await page.getByRole('button', { name: 'Save Memo' }).click();

        // Keep browser open after test completes
    await page.pause();
  });
});
