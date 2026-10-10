import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.beforeEach(async ({ page, request }) => {
  await request.post('/__fixture/reset', { data: {} });
  await page.goto('/');
  await expect(page.getByLabel('Name size', { exact: true })).toBeVisible();
});
const counters = async request => (await request.get('/api/counters')).json();

test('keyboard draft, labelled locked control, follow-up and explicit Apply roundtrip are accessible', async ({ page, request }) => {
  const posts = []; page.on('request', req => { if (req.method() === 'POST') posts.push(req.url()); });
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Name size', { exact: true })).toBeFocused();
  // Native select type-ahead works on macOS and Linux headless Chromium.
  await page.keyboard.press('l');
  await expect(page.getByLabel('Name size', { exact: true })).toHaveValue('large');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Layout', { exact: true })).toBeFocused();
  await page.keyboard.press('s');
  await expect(page.getByLabel('Stacked layout emphasis')).toBeVisible();
  await expect(page.getByLabel('Approved logo position')).toBeDisabled();
  await expect(page.getByLabel('Approved logo position')).toHaveAttribute('aria-describedby', 'lock-c03');
  await expect(page.getByLabel('Stacked layout emphasis')).toHaveAttribute('required', '');
  expect(posts).toEqual([]);
  expect(await counters(request)).toMatchObject({ jobs: 0, jev_calls: 0, image_calls: 0, mode: 'mock' });
  const before = await new AxeBuilder({ page }).analyze(); expect(before.violations).toEqual([]);
  // Tab through editable controls; the locked select is skipped by the browser.
  await page.keyboard.press('Tab'); await expect(page.getByLabel('Artwork style')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByLabel('Stacked layout emphasis')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('Apply accepted');
  await page.getByRole('button', { name: 'Validate handoff' }).click();
  await expect(page.getByRole('status')).toContainText('Typed handoff ready');
  expect(await counters(request)).toMatchObject({ jobs: 1, jev_calls: 0, image_calls: 0 });
  const after = await new AxeBuilder({ page }).analyze(); expect(after.violations).toEqual([]);
  await page.screenshot({ path: 'test-results/mock-roundtrip.png', fullPage: true });
});

test('lost response, Retry and simultaneous duplicates retain one durable operation identity', async ({ page, request }) => {
  let sent;
  await page.route('**/api/apply', async route => { sent = route.request().postDataJSON(); await route.fetch(); await route.abort('failed'); });
  await page.getByLabel('Name size', { exact: true }).selectOption('large');
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Retry last Apply');
  expect(await counters(request)).toMatchObject({ jobs: 1, jev_calls: 0, image_calls: 0 });
  await page.unroute('**/api/apply');
  await page.getByRole('button', { name: 'Retry last Apply' }).click();
  await expect(page.getByRole('status')).toContainText('Existing operation returned');
  const results = await Promise.all([request.post('/api/apply', { data: sent }), request.post('/api/apply', { data: sent })]);
  const bodies = await Promise.all(results.map(r => r.json()));
  expect(bodies.every(r => r.code === 'replayed')).toBe(true);
  expect(new Set(bodies.map(r => r.operation_id)).size).toBe(1);
  expect(await counters(request)).toMatchObject({ jobs: 1, jev_calls: 0, image_calls: 0 });
});

test('stale controls reject Apply with focused accessible error; Refresh requires fresh review', async ({ page, request }) => {
  await page.getByLabel('Name size', { exact: true }).selectOption('large');
  await request.post('/__fixture/state', { data: { advance_design: true } });
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('stale'); await expect(page.getByRole('alert')).toBeFocused();
  expect(await counters(request)).toMatchObject({ jobs: 0, jev_calls: 0, image_calls: 0 });
  await page.getByRole('button', { name: 'Refresh controls' }).click();
  await expect(page.getByLabel('Name size', { exact: true })).toHaveValue('medium');
  await expect(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeDisabled();
  await expect(page.locator('#versions')).toContainText('design_v2');
  await page.getByLabel('Name size', { exact: true }).selectOption('large');
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Apply accepted');
});

for (const [name, mutate, message] of [
  ['cross-tenant action', a => { a.tenant_id = 'forged_tenant'; }, 'Permission denied'],
  ['cross-project action', a => { a.project_id = 'forged_project'; }, 'Permission denied'],
  ['invalid action', a => { a.html = '<script>window.attack=true</script>'; }, 'unknown_field'],
  ['privileged action', a => { a.intent = 'purchase'; }, 'invalid_intent'],
  ['unsupported schema', a => { a.schema_version = 'creative-controls/2.0'; }, 'unsupported_version'],
]) test(`${name} is rejected over actual browser Apply path without a job`, async ({ page, request }) => {
  await page.route('**/api/apply', async route => { const body = route.request().postDataJSON(); mutate(body); await route.continue({ postData: JSON.stringify(body) }); });
  await page.getByLabel('Name size', { exact: true }).selectOption('large');
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(message);
  expect(await counters(request)).toMatchObject({ jobs: 0, jev_calls: 0, image_calls: 0 });
  expect(await page.evaluate(() => window.attack)).toBeUndefined();
});

test('permission revoked between Apply and handoff prevents dispatch; cancellation blocks late retry', async ({ page, request }) => {
  await page.getByLabel('Name size', { exact: true }).selectOption('large');
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Apply accepted');
  await request.post('/__fixture/state', { data: { revoke: true } });
  await page.getByRole('button', { name: 'Validate handoff' }).click();
  await expect(page.getByRole('alert')).toContainText('Permission denied');
  await page.getByRole('button', { name: 'Cancel operation' }).click();
  await expect(page.getByRole('status')).toContainText('Operation cancelled');
  // Cancelling does not grant an approval, and retry under revoked authority still fails.
  await page.getByRole('button', { name: 'Retry last Apply' }).click();
  await expect(page.getByRole('alert')).toContainText('Permission denied');
  expect(await counters(request)).toMatchObject({ jobs: 1, jev_calls: 0, image_calls: 0 });
});

test('artwork choice is a typed pending operation; paid handoff unavailable', async ({ page, request }) => {
  await page.getByLabel('Artwork style').selectOption('vibrant');
  expect(await counters(request)).toMatchObject({ jobs: 0, jev_calls: 0, image_calls: 0 });
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Apply accepted');
  await page.getByRole('button', { name: 'Validate handoff' }).click();
  await expect(page.getByRole('alert')).toContainText('Handoff unavailable');
  expect(await counters(request)).toMatchObject({ jobs: 1, jev_calls: 0, image_calls: 0 });
});

test('browser consumer rejects executable schema before rendering it', async ({ page }) => {
  await page.route('**/api/schema', async route => {
    const response = await route.fetch(); const data = await response.json(); data.schema.controls[0].kind = 'script';
    await route.fulfill({ response, json: data });
  });
  await page.getByRole('button', { name: 'Refresh controls' }).click();
  await expect(page.getByRole('alert')).toContainText('Controls unavailable');
  expect(await page.evaluate(() => window.attack)).toBeUndefined();
});

test('stored stacked emphasis survives refresh and a later name-size edit', async ({ page, request }) => {
  await request.post('/__fixture/state', { data: { stacked_name: true } });
  await page.getByRole('button', { name: 'Refresh controls' }).click();
  await expect(page.getByLabel('Stacked layout emphasis')).toHaveValue('name');
  await page.getByLabel('Name size', { exact: true }).selectOption('large');
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Apply accepted');
  const response = page.waitForResponse('**/api/dispatch');
  await page.getByRole('button', { name: 'Validate handoff' }).click();
  const handoff = await (await response).json();
  expect(handoff.operation.tasks[0].changes).toEqual([{ field: 'name_size', value: 'large' }]);
  expect(handoff.operation.tasks[0].follow_up_answers).toEqual({ q01: 'name' });
  expect(await counters(request)).toMatchObject({ jobs: 1, jev_calls: 0, image_calls: 0 });
});

test('follow-up-only browser edit is an explicit composition change and honors locks', async ({ page, request }) => {
  await request.post('/__fixture/state', { data: { stacked_name: true, lock_followup: true } });
  await page.getByRole('button', { name: 'Refresh controls' }).click();
  await expect(page.getByLabel('Stacked layout emphasis')).toBeDisabled();
  await request.post('/__fixture/reset', { data: {} });
  await request.post('/__fixture/state', { data: { stacked_name: true } });
  await page.getByRole('button', { name: 'Refresh controls' }).click();
  await page.getByLabel('Stacked layout emphasis').selectOption('balanced');
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Apply accepted');
  const response = page.waitForResponse('**/api/dispatch');
  await page.getByRole('button', { name: 'Validate handoff' }).click();
  const handoff = await (await response).json();
  expect(handoff.operation.tasks[0].changes).toEqual([{ field: 'layout_emphasis', value: 'balanced' }]);
  expect(handoff.operation.tasks[0].follow_up_answers).toEqual({ q01: 'balanced' });
  expect(await counters(request)).toMatchObject({ jobs: 1, jev_calls: 0, image_calls: 0 });
});
