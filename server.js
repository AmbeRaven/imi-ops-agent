import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import Browserbase from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.status(200).send('ok'));

function authorized(req) {
  const expected = process.env.IMI_AGENT_PASSCODE;
  if (!expected) return false;
  return req.get('x-imi-passcode') === expected || req.query.passcode === expected;
}

app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const required = ['OPENAI_API_KEY', 'BROWSERBASE_API_KEY', 'IMI_AGENT_PASSCODE'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) console.warn(`Missing environment variables: ${missing.join(', ')}`);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
const businessProfile = JSON.parse(await fs.readFile(path.join(__dirname, 'business-profile.json'), 'utf8'));

const sessions = new Map();

const approvalPattern = /\b(submit|publish|post|create|register|purchase|buy|pay|confirm|delete|remove|send|save|accept|agree|sign|book|order|apply|finish|complete)\b/i;
const credentialPattern = /password|passcode|verification code|2fa|mfa|one[- ]time code|otp/i;

function systemInstructions() {
  return `You are the private browser operator for ʻIMI Analytics. You control a browser only through the supplied tools.

BUSINESS PROFILE:\n${JSON.stringify(businessProfile, null, 2)}

Rules:
1. Work toward the user's requested website task autonomously.
2. Observe before acting. Prefer labels and visible text over fragile CSS selectors.
3. Never type passwords, one-time codes, payment-card data, SSNs, or other credentials. Ask the user to take over in Live View for those.
4. Never bypass CAPTCHAs, bot protection, MFA, or website safeguards.
5. Before any consequential final action (publishing, submitting, creating an account/page/profile, sending a message, making a purchase, accepting terms, deleting, or changing public information), call request_approval instead of taking that action.
6. If a site requires login, verification, CAPTCHA, file upload, or visual judgment that is unreliable, call request_takeover.
7. Do not claim success unless the browser shows confirmation.
8. Keep responses concise. When paused, clearly say what the user needs to do.
9. The user wants tedious setup automated. Fill ordinary non-sensitive fields without asking when the business profile gives the answer.
10. Do not alter personal profiles or unrelated account settings unless the user explicitly asks.`;
}

const tools = [
  {
    type: 'function', name: 'observe',
    description: 'Read the current page URL, title, visible text, and interactive controls.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    type: 'function', name: 'navigate',
    description: 'Navigate the browser to a URL.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false }
  },
  {
    type: 'function', name: 'click',
    description: 'Click a visible control using its exact or near-exact text/accessible label. Never use this for a final consequential action; request approval first.',
    parameters: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false }
  },
  {
    type: 'function', name: 'fill',
    description: 'Fill an ordinary non-sensitive field identified by its label or placeholder.',
    parameters: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['label','value'], additionalProperties: false }
  },
  {
    type: 'function', name: 'select',
    description: 'Choose an option in a select or combobox.',
    parameters: { type: 'object', properties: { label: { type: 'string' }, option: { type: 'string' } }, required: ['label','option'], additionalProperties: false }
  },
  {
    type: 'function', name: 'press',
    description: 'Press a keyboard key, such as Enter, Tab, Escape, ArrowDown.',
    parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false }
  },
  {
    type: 'function', name: 'request_approval',
    description: 'Pause before a consequential final action and ask the user to approve it.',
    parameters: { type: 'object', properties: { action: { type: 'string' }, reason: { type: 'string' } }, required: ['action','reason'], additionalProperties: false }
  },
  {
    type: 'function', name: 'request_takeover',
    description: 'Pause so the user can manually control the remote browser through Live View for login, CAPTCHA, MFA, sensitive data, or other manual steps.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false }
  }
];

async function connectSession(sessionId) {
  const state = sessions.get(sessionId);
  if (!state) throw new Error('Unknown or expired session. Start a new browser session.');
  if (state.page && !state.page.isClosed()) return state;

  const browser = await chromium.connectOverCDP(state.connectUrl);
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  Object.assign(state, { browser, context, page });
  return state;
}

async function snapshot(page) {
  const title = await page.title().catch(() => '');
  const url = page.url();
  const text = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 14000);
  const controls = await page.locator('a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="combobox"]').evaluateAll(els =>
    els.slice(0, 150).map((el, i) => ({
      i,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().slice(0, 160),
      type: el.getAttribute('type') || '',
      disabled: !!el.disabled
    })).filter(x => x.text)
  ).catch(() => []);
  return { url, title, text, controls };
}

async function findByLabel(page, label) {
  const exact = label.trim();
  const candidates = [
    page.getByRole('button', { name: exact, exact: false }),
    page.getByRole('link', { name: exact, exact: false }),
    page.getByLabel(exact, { exact: false }),
    page.getByPlaceholder(exact, { exact: false }),
    page.getByText(exact, { exact: false })
  ];
  for (const locator of candidates) {
    if (await locator.count().catch(() => 0)) return locator.first();
  }
  throw new Error(`Could not find a visible control matching: ${label}`);
}

async function executeTool(state, name, args) {
  const page = state.page;
  if (name === 'observe') return snapshot(page);
  if (name === 'navigate') {
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return snapshot(page);
  }
  if (name === 'fill') {
    if (credentialPattern.test(args.label) || credentialPattern.test(args.value)) {
      return { paused: true, kind: 'takeover', reason: 'Sensitive credential field detected. Please enter it yourself in Live View.' };
    }
    const locator = await findByLabel(page, args.label);
    const type = await locator.getAttribute('type').catch(() => '');
    if (type === 'password') return { paused: true, kind: 'takeover', reason: 'Password entry requires manual takeover.' };
    await locator.fill(args.value);
    return { ok: true, page: await snapshot(page) };
  }
  if (name === 'select') {
    const locator = await findByLabel(page, args.label);
    await locator.selectOption({ label: args.option }).catch(async () => {
      await locator.click();
      await page.getByRole('option', { name: args.option, exact: false }).first().click();
    });
    return { ok: true, page: await snapshot(page) };
  }
  if (name === 'press') {
    await page.keyboard.press(args.key);
    return { ok: true, page: await snapshot(page) };
  }
  if (name === 'click') {
    if (approvalPattern.test(args.label)) {
      return { paused: true, kind: 'approval', action: `Click “${args.label}”`, reason: 'This looks like a consequential or final action.' };
    }
    const locator = await findByLabel(page, args.label);
    await locator.click();
    await page.waitForTimeout(500);
    return { ok: true, page: await snapshot(page) };
  }
  if (name === 'request_approval') return { paused: true, kind: 'approval', ...args };
  if (name === 'request_takeover') return { paused: true, kind: 'takeover', ...args };
  throw new Error(`Unknown tool: ${name}`);
}

async function runAgent(state, userText) {
  let response = await openai.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-5.6',
    instructions: systemInstructions(),
    input: userText,
    tools,
    store: false
  });

  for (let step = 0; step < 18; step++) {
    const calls = response.output?.filter(x => x.type === 'function_call') || [];
    if (!calls.length) return { status: 'done', message: response.output_text || 'Done.' };

    const outputs = [];
    for (const call of calls) {
      const args = JSON.parse(call.arguments || '{}');
      const result = await executeTool(state, call.name, args);
      if (result?.paused) {
        state.pending = { call, args, result, previousResponseId: response.id };
        return { status: result.kind, ...result };
      }
      outputs.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
    }

    response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-5.6',
      instructions: systemInstructions(),
      previous_response_id: response.id,
      input: outputs,
      tools,
      store: false
    });
  }
  return { status: 'done', message: 'I reached the step limit. Tell me to continue and I’ll pick up from the current page.' };
}

app.get('/api/profile', (req, res) => res.json(businessProfile));

app.post('/api/session', async (req, res) => {
  try {
    const sessionOptions = { keepAlive: true };
    if (process.env.BROWSERBASE_PROJECT_ID) sessionOptions.projectId = process.env.BROWSERBASE_PROJECT_ID;
    const session = await bb.sessions.create(sessionOptions);
    const debug = await bb.sessions.debug(session.id);
    const state = { id: session.id, connectUrl: session.connectUrl, debugUrl: debug.debuggerUrl, pending: null };
    sessions.set(session.id, state);
    await connectSession(session.id);
    res.json({ sessionId: session.id, liveViewUrl: debug.debuggerUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/command', async (req, res) => {
  try {
    const { sessionId, command } = req.body;
    if (!sessionId || !command) return res.status(400).json({ error: 'sessionId and command are required' });
    const state = await connectSession(sessionId);
    state.pending = null;
    res.json(await runAgent(state, command));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/approve', async (req, res) => {
  try {
    const { sessionId, approved } = req.body;
    const state = await connectSession(sessionId);
    const pending = state.pending;
    if (!pending) return res.status(400).json({ error: 'No pending approval.' });
    if (!approved) {
      state.pending = null;
      return res.json({ status: 'done', message: 'Cancelled. I did not take the action.' });
    }

    const { call, args, previousResponseId, result } = pending;
    let execution;
    if (call.name === 'click' || result.action?.startsWith('Click')) {
      const label = args.label || result.action?.match(/“(.+)”/)?.[1];
      const locator = await findByLabel(state.page, label);
      await locator.click();
      await state.page.waitForTimeout(700);
      execution = { approved: true, executed: true, page: await snapshot(state.page) };
    } else {
      execution = { approved: true, note: 'User approved the requested action. Continue and execute it if needed.' };
    }
    state.pending = null;

    let response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-5.6',
      instructions: systemInstructions(),
      previous_response_id: previousResponseId,
      input: [{ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(execution) }],
      tools,
      store: false
    });

    // Continue any subsequent non-sensitive calls through the regular loop by giving the model context as a new command.
    const text = response.output_text || 'Approved action completed. Continue from the current page.';
    const calls = response.output?.filter(x => x.type === 'function_call') || [];
    if (!calls.length) return res.json({ status: 'done', message: text });

    // Use a simple continuation command to restart the guarded loop from current page.
    res.json(await runAgent(state, 'Continue the task from the current browser state. The previously requested action was approved and completed.'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/resume', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const state = await connectSession(sessionId);
    state.pending = null;
    res.json(await runAgent(state, 'I completed the manual takeover step. Observe the current page and continue the task.'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/state/:sessionId', async (req, res) => {
  try {
    const state = await connectSession(req.params.sessionId);
    res.json(await snapshot(state.page));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`ʻIMI Ops Agent running on http://localhost:${port}`));
