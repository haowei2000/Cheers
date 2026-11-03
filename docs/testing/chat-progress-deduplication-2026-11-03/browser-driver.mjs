import { createRequire } from 'node:module';
const { chromium, expect } = createRequire(new URL('../../../frontend/package.json', import.meta.url))('@playwright/test');
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHmac } from 'node:crypto';

const dir = process.env.CHEERS_TRACE_E2E_DIR;
if (!dir) throw new Error('CHEERS_TRACE_E2E_DIR must contain a private fixture.json');
const fixture = JSON.parse(await readFile(`${dir}/fixture.json`));
function loopbackOrigin(name) {
  const url = new URL(process.env[name] ?? '');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`${name} must be an HTTP loopback origin with an explicit port`);
  return url.origin;
}
const base = loopbackOrigin('INTEGRATION_BASE_URL');
const bridgeBase = loopbackOrigin('E2E_GATEWAY_URL').replace(/^http:/, 'ws:');
const sockets = [];
const report = { checks: [], browserErrors: [], bridgeErrors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const storageState = undefined;
const context = await browser.newContext({ storageState, viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' });
const page = await context.newPage();
page.setDefaultTimeout(20000);
page.on('pageerror', error => report.browserErrors.push(error.message));
page.on('response', response => {
  if (response.url().includes('/auth/') && !response.ok()) console.log('AUTH ERROR', new URL(response.url()).pathname, response.status());
});

function totp(secret) {
  let bits = '';
  for (const c of secret.replace(/=+$/, '')) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hash = createHmac('sha1', key).update(counter).digest();
  return String((hash.readUInt32BE(hash[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}

async function bridge(stream) {
  const socket = new WebSocket(`${bridgeBase}/ws/agent-bridge/${stream}`);
  sockets.push(socket);
  const queue = [];
  const waiters = [];
  socket.addEventListener('message', event => {
    const frame = JSON.parse(event.data);
    if (frame.type === 'error') report.bridgeErrors.push(frame);
    const index = waiters.findIndex(waiter => waiter.type === frame.type);
    if (index >= 0) waiters.splice(index, 1)[0].resolve(frame);
    else queue.push(frame);
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const result = {
    send: frame => socket.send(JSON.stringify(frame)),
    next(type) {
      const index = queue.findIndex(frame => frame.type === type);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for bridge ${stream}/${type}; received ${queue.map(frame => frame.type)}`)), 20000);
        waiters.push({ type, resolve: frame => { clearTimeout(timer); resolve(frame); } });
      });
    },
  };
  result.send({ type: 'auth', token: fixture.host.credential, bridge_protocol_version: 1 });
  expect((await result.next('hello')).bot_id).toBe(fixture.bot.bot_id);
  return result;
}

try {
  if (!storageState) {
  await page.goto(`${base}/login`);
  await page.getByRole('textbox', { name: 'Username or Email', exact: true }).fill(fixture.user.username);
  await page.getByLabel('Password', { exact: true }).fill(fixture.user.password);
  await Promise.all([
    page.waitForResponse(response => /\/auth\/flows\/[^/]+\/password$/.test(new URL(response.url()).pathname)).then(response => console.log('PASSWORD', response.status())),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
  const code = page.getByLabel('Verification code', { exact: true });
  await code.waitFor();
  await code.fill(totp(fixture.totpSecret));
  const [verified] = await Promise.all([
    page.waitForResponse(response => /\/auth\/flows\/[^/]+\/totp\/verify$/.test(new URL(response.url()).pathname)),
    page.getByRole('button', { name: 'Verify', exact: true }).click(),
  ]);
  expect(verified.ok()).toBe(true);
  fixture.userAuth = await verified.json();
  await writeFile(`${dir}/fixture.json`, JSON.stringify(fixture), { mode: 0o600 });
  await page.waitForURL(url => url.pathname.startsWith('/chat'));
  report.checks.push('real browser password + TOTP login');
  await writeFile(`${dir}/test-browser-state.json`, JSON.stringify(await context.storageState()), { mode: 0o600 });
  console.log('PASS login');
  } else {
    await page.goto(`${base}/chat`);
    await page.getByRole('button', { name: 'Personal', exact: true }).waitFor();
    report.checks.push('real password + TOTP session restored through gateway refresh');
    console.log('PASS real session restore');
  }

  const headers = { Authorization: `Bearer ${fixture.userAuth.access_token}` };
  expect((await page.request.delete(`${base}/api/v1/channels/${fixture.channel.channel_id}`, { headers })).ok()).toBe(true);
  const created = await page.request.post(`${base}/api/v1/channels`, { headers, data: { workspace_id: fixture.userWorkspace.workspace_id, name: `trace-e2e-${Date.now()}`, type: 'private', initial_bot_ids: [fixture.bot.bot_id] } });
  expect(created.ok()).toBe(true);
  fixture.channel = await created.json();
  await writeFile(`${dir}/fixture.json`, JSON.stringify(fixture), { mode: 0o600 });

  const control = await bridge('control');
  const data = await bridge('data');
  control.send({ type: 'ready', v: 1, connector_capabilities: { task_acceptance: true, terminal_replay: true } });
  await page.goto(`${base}/chat/${fixture.userWorkspace.workspace_id}/${fixture.channel.channel_id}`);
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.waitFor();
  await expect(page.getByRole('button', { name: fixture.channel.name, exact: true })).toHaveAttribute('aria-current', 'page');
  console.log('PASS real channel');

  async function startTurn(label) {
    await input.fill(`@${fixture.bot.username}`);
    await page.getByRole('button', { name: /Trace E2E Agent.*BOT/ }).click();
    await input.press('End');
    await input.pressSequentially(` ${label}`);
    await input.press('Enter');
    const task = await control.next('task');
    expect(task.channel_id).toBe(fixture.channel.channel_id);
    const execution = randomUUID();
    control.send({ type: 'task_accept', v: 1, task_id: task.task_id, placeholder_msg_id: task.placeholder_msg_id, channel_id: task.channel_id, execution_id: execution });
    expect((await control.next('task_acceptance')).status).toBe('granted');
    return { task, execution, seq: 0 };
  }
  function trace(turn, phase, status, title, extra = {}) {
    data.send({ type: 'trace', v: 1, id: randomUUID(), msg_id: turn.task.placeholder_msg_id, channel_id: turn.task.channel_id, task_id: turn.task.task_id, provider_session_key: turn.task.provider_session_key, session_id: turn.task.session_id, stream: 'acp', seq: ++turn.seq, phase, status, title, ...extra });
  }
  async function finish(turn, status, content) {
    trace(turn, 'prompt_finished', status, 'Finished');
    data.send({ type: 'done', v: 1, client_msg_id: randomUUID(), msg_id: turn.task.placeholder_msg_id, content, execution: { task_id: turn.task.task_id, execution_id: turn.execution, channel_id: turn.task.channel_id }, provider_session_key: turn.task.provider_session_key, session_id: turn.task.session_id });
    const ack = await data.next('terminal_ack');
    if (!ack.ok) console.log('TERMINAL ACK', JSON.stringify(ack));
    expect(ack.ok).toBe(true);
  }

  const turn = await startTurn('Trace progress E2E');
  trace(turn, 'prompt_started', 'in_progress', 'Run started');
  await expect(page.locator('[aria-live="polite"]', { hasText: 'Running' })).toHaveCount(1);
  await expect(page.locator('[id^="trace-source-"]')).toHaveCount(0);
  const command = 'echo trace-e2e-check';
  const tool = { tool_call_id: 'e2e-tool-1', data: { tool_call_id: 'e2e-tool-1', command } };
  trace(turn, 'tool_call', 'in_progress', command, tool);
  await expect(page.locator('[aria-live="polite"]', { hasText: 'Running · 1 tool' })).toHaveCount(1);
  await expect(page.locator('[id^="trace-source-"]')).toHaveCount(1);
  await expect(page.getByText(command, { exact: true })).toHaveCount(1);
  await expect(page.getByLabel('Agent thinking', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Typewriter cursor', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-item-kind="conversation"]').filter({ has: page.locator('[aria-live="polite"]') }).getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(1);
  await page.screenshot({ path: `${dir}/02-live-progress.png`, fullPage: true });
  report.checks.push('real browser send -> task acceptance -> bridge trace -> channel WS; single progress/status/Stop');
  console.log('PASS live trace');

  trace(turn, 'tool_call_update', 'failed', command, tool);
  await expect(page.locator('[aria-live="polite"]', { hasText: 'Running · 1 tool · 1 tool failed' })).toHaveCount(1);
  data.send({ type: 'delta', v: 1, msg_id: turn.task.placeholder_msg_id, seq: 1, delta: 'Trace E2E response', provider_session_key: turn.task.provider_session_key, session_id: turn.task.session_id });
  await expect(page.getByText('Trace E2E response', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Typewriter cursor', { exact: true })).toHaveCount(0);
  report.checks.push('tool failure remains Running; streamed content does not duplicate progress');

  const requestId = randomUUID();
  data.send({ type: 'permission_request', v: 1, client_msg_id: randomUUID(), channel_id: turn.task.channel_id, task_id: turn.task.task_id, msg_id: turn.task.placeholder_msg_id, provider_session_key: turn.task.provider_session_key, session_id: turn.task.session_id, request_id: requestId, title: 'Approve E2E command', body: 'Approve deterministic test action', tool: { title: command, command, kind: 'execute' }, options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' }] });
  expect((await data.next('send_ack')).ok).toBe(true);
  await expect(page.locator('[aria-live="polite"]', { hasText: 'Awaiting approval' })).toHaveCount(1);
  await expect(page.locator('[id^="trace-source-"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /Allow once|Approve once/, exact: false })).toBeVisible();
  await expect(page.getByText('Needs approval', { exact: true })).toHaveCount(1);
  await expect(page.getByText(command, { exact: true })).toHaveCount(1);
  await page.screenshot({ path: `${dir}/03-approval.png`, fullPage: true });
  console.log('APPROVAL UI', (await page.locator('body').innerText()).slice(-2200));
  // Resolve through the real card, keeping its business action and WS delivery in scope.
  await page.getByRole('button', { name: /Allow once|Approve once/, exact: false }).click();
  await expect(page.locator('[aria-live="polite"]', { hasText: 'Awaiting approval' })).toHaveCount(0);
  report.checks.push('real permission request; one inline approval; browser resolution');
  console.log('PASS approval');

  await finish(turn, 'completed', 'Trace E2E response complete');
  await expect(page.locator('[aria-live="polite"]', { hasText: 'Completed · 1 tool · 1 tool failed' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
  await expect(page.locator('[id^="trace-source-"]')).toHaveCount(0);
  await page.reload();
  const completed = page.locator('[aria-live="polite"]', { hasText: 'Completed · 1 tool · 1 tool failed' });
  await expect(completed).toHaveCount(1);
  const openRecord = page.getByRole('button', { name: /^Open message record: Completed/ });
  await openRecord.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').locator('[id^="trace-source-"]')).not.toHaveCount(0);
  await page.screenshot({ path: `${dir}/04-persisted-record.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(openRecord).toBeFocused();
  report.checks.push('terminal ACK; completion with tool error; PG-backed summary/history survives reload; keyboard record');
  console.log('PASS durable record');

  const cancelled = await startTurn('Stop progress E2E');
  trace(cancelled, 'tool_call', 'in_progress', 'Cancellable E2E step', { data: { tool_call_id: 'e2e-stop' } });
  const stop = page.locator('[data-item-kind="conversation"]').filter({ has: page.locator('[aria-live="polite"]', { hasText: 'Running' }) }).getByRole('button', { name: 'Stop response', exact: true });
  await expect(stop).toHaveCount(1);
  const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/messages/${cancelled.task.placeholder_msg_id}/cancel`));
  await stop.click();
  expect((await responsePromise).ok()).toBe(true);
  expect((await control.next('cancel')).msg_id).toBe(cancelled.task.placeholder_msg_id);
  trace(cancelled, 'prompt_finished', 'cancelled', 'Cancelled by user');
  await expect(page.locator('[aria-live="polite"]', { hasText: 'Cancelled' })).toHaveCount(1);
  report.checks.push('single Stop -> real cancel HTTP -> connector control WS -> cancelled lifecycle');
  console.log('PASS stop');

  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${base}/chat/${fixture.userWorkspace.workspace_id}/${fixture.channel.channel_id}`);
      if (width < 768) {
        const channelButton = page.getByRole('button', { name: fixture.channel.name, exact: true });
        await expect.poll(async () => await completed.isVisible() || await channelButton.isVisible(), { timeout: 20000 }).toBe(true);
        if (!(await completed.isVisible())) await channelButton.click();
      }
      await expect(completed).toHaveCount(1);
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await completed.evaluate(span => span.scrollWidth <= span.clientWidth + 1 && span.scrollHeight <= span.clientHeight + 1)).toBe(true);
      await page.screenshot({ path: `${dir}/05-${theme}-${width}.png`, fullPage: true });
    }
  }
  report.checks.push('real conversation: light/dark 390/768/1280, no page overflow or summary clipping');
  expect(report.browserErrors).toEqual([]);
  expect(report.bridgeErrors).toEqual([]);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  await page.screenshot({ path: `${dir}/failure.png`, fullPage: true }).catch(() => {});
  console.log('FAIL UI', (await page.locator('body').innerText()).slice(-3000));
  process.exitCode = 1;
} finally {
  await writeFile(`${dir}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  for (const socket of sockets) socket.close();
  await browser.close();
}
