import { test, expect } from '@playwright/test';
test('create, budget, checkpoint, resume, accept, and inspect evidence', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '把额度，留给重要的事。' })).toBeVisible();
  await expect(page.getByText('当前为独立演示空间', { exact: false })).toBeVisible();
  await page.screenshot({ path: `test-results/overview-${info.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: '添加任务', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const name = `端到端验收-${info.project.name}`;
  await dialog.getByLabel('任务名称').fill(name);
  await dialog.getByLabel('项目', { exact: true }).fill('qa-project');
  await dialog.getByLabel('重要性').selectOption('must');
  await dialog.getByLabel('最低估计').fill('1');
  await dialog.getByLabel('最高估计').fill('2');
  await dialog.getByLabel('收尾预留').fill('1');
  await dialog.getByLabel('验收要求').fill('验证保存与恢复');
  await dialog.getByRole('button', { name: '保存任务' }).click();
  await expect(dialog).not.toBeVisible();
  const row = page
    .locator('.task-row')
    .filter({ has: page.getByRole('button', { name, exact: true }) });
  await expect(row).toContainText('3 pp');
  await row.getByRole('button', { name: `保存 ${name} 的断点` }).click();
  await page.getByLabel('断点说明').fill('已改文件：test.ts\n验证结果：通过\n下一步：复核');
  await page.getByRole('button', { name: '保存并暂停' }).click();
  await expect(row).toContainText('已暂停');
  await row.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(row).toContainText('排队中');
  await row.getByRole('button', { name: `保存 ${name} 的断点` }).click();
  await page.getByRole('button', { name: '保存并暂停' }).click();
  await row.getByRole('button', { name: `保存 ${name} 的断点` }).click();
  await page.getByLabel('确认已满足验收要求', { exact: false }).check();
  await page.getByLabel('观测到的额度成本', { exact: false }).fill('2.5');
  await page.getByRole('button', { name: '保存并验收' }).click();
  await expect(page.getByRole('status')).toContainText('已记录验收通过');
  await page.reload();
  await page.getByRole('button', { name: '策略成绩单' }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重置信号' }).click();
  await expect(page.getByRole('heading', { name: '重置信号，逐条有据。' })).toBeVisible();
  await expect(page.getByText('历史样本不足，暂不估计').first()).toBeVisible();
  await page.getByRole('button', { name: '调度设置' }).click();
  await page.getByLabel('应急预留百分比').fill('25');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('status')).toContainText('调度设置已保存');
  await page.getByRole('button', { name: '任务与预算' }).click();
  await expect(page.getByText('25%', { exact: true })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: `test-results/dashboard-${info.project.name}.png`,
    fullPage: true,
  });
});
test('keyboard access, reduced motion and form validation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: '添加任务', exact: true }).click();
  await expect(page.getByLabel('任务名称')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '添加任务', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '添加任务', exact: true }).click();
  await page.getByRole('button', { name: '保存任务' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
});
