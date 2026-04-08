// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts('data/names.js');

const LOG_PREFIX = '[MultiPage:bg]';
const MAIL_PROVIDERS = ['163', 'qq'];

function createDefaultMailSettings() {
  return {
    '163': { emailDomain: '' },
    qq: { emailDomain: '' },
  };
}

function normalizeMailSettings(rawSettings, activeProvider = '163', legacyEmailDomain = '') {
  const defaults = createDefaultMailSettings();
  const settings = { ...defaults };

  for (const provider of MAIL_PROVIDERS) {
    const rawDomain = rawSettings?.[provider]?.emailDomain;
    settings[provider] = {
      emailDomain: typeof rawDomain === 'string' ? rawDomain : '',
    };
  }

  if (legacyEmailDomain && !settings[activeProvider]?.emailDomain) {
    settings[activeProvider].emailDomain = legacyEmailDomain;
  }

  return settings;
}

// ============================================================
// State Management (chrome.storage.session)
// ============================================================

const DEFAULT_STATE = {
  currentStep: 0,
  stepStatuses: {
    1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending',
    6: 'pending', 7: 'pending',
  },
  oauthUrl: null,
  email: null,
  password: null,
  accounts: [], // { email, password, createdAt }
  lastEmailTimestamp: null,
  localhostUrl: null,
  directAuthSuccess: false,
  flowStartTime: null,
  incognitoWindowId: null,
  tabRegistry: {},
  logs: [],
  vpsUrl: '',
  mailProvider: '163', // 'qq' or '163'
  emailDomain: '',
  mailSettings: createDefaultMailSettings(),
};

async function getState() {
  const state = await chrome.storage.session.get(null);
  const merged = { ...DEFAULT_STATE, ...state };
  const mailProvider = merged.mailProvider || '163';
  const mailSettings = normalizeMailSettings(merged.mailSettings, mailProvider, merged.emailDomain);
  return {
    ...merged,
    mailProvider,
    mailSettings,
    emailDomain: mailSettings[mailProvider]?.emailDomain || merged.emailDomain || '',
  };
}

async function setState(updates) {
  console.log(LOG_PREFIX, 'storage.set:', JSON.stringify(updates).slice(0, 200));
  await chrome.storage.session.set(updates);
}

async function resetState() {
  console.log(LOG_PREFIX, 'Resetting all state');
  // Close incognito window if still open
  await closeIncognitoWindow();
  // Preserve settings and persistent data across resets
  const prev = await chrome.storage.session.get(['seenCodes', 'tabRegistry', 'vpsUrl', 'mailProvider', 'emailDomain', 'mailSettings']);
  const mailProvider = prev.mailProvider || '163';
  const mailSettings = normalizeMailSettings(prev.mailSettings, mailProvider, prev.emailDomain || '');
  await chrome.storage.session.clear();
  await chrome.storage.session.set({
    ...DEFAULT_STATE,
    seenCodes: prev.seenCodes || [],
    accounts: [], // accounts now live in chrome.storage.local
    tabRegistry: prev.tabRegistry || {},
    vpsUrl: prev.vpsUrl || '',
    mailProvider,
    emailDomain: mailSettings[mailProvider]?.emailDomain || '',
    mailSettings,
  });
}

// ============================================================
// Persistent Accounts (chrome.storage.local)
// ============================================================

async function getAccounts() {
  const data = await chrome.storage.local.get('accounts');
  return data.accounts || [];
}

async function saveAccount(account) {
  const accounts = await getAccounts();
  accounts.push(account);
  await chrome.storage.local.set({ accounts });
  // Broadcast to side panel
  chrome.runtime.sendMessage({
    type: 'ACCOUNT_ADDED',
    payload: account,
  }).catch(() => {});
  return accounts;
}

async function deleteAccount(index) {
  const accounts = await getAccounts();
  if (index >= 0 && index < accounts.length) {
    accounts.splice(index, 1);
    await chrome.storage.local.set({ accounts });
  }
  return accounts;
}

async function clearAccounts() {
  await chrome.storage.local.set({ accounts: [] });
}

/**
 * Generate a random password: 14 chars, mix of uppercase, lowercase, digits, symbols.
 */
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*?';
  const all = upper + lower + digits + symbols;

  // Ensure at least one of each type
  let pw = '';
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += digits[Math.floor(Math.random() * digits.length)];
  pw += symbols[Math.floor(Math.random() * symbols.length)];

  // Fill remaining 10 chars
  for (let i = 0; i < 10; i++) {
    pw += all[Math.floor(Math.random() * all.length)];
  }

  // Shuffle
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

// ============================================================
// Tab Registry
// ============================================================

async function getTabRegistry() {
  const state = await getState();
  return state.tabRegistry || {};
}

async function registerTab(source, tabId) {
  const registry = await getTabRegistry();
  registry[source] = { tabId, ready: true };
  await setState({ tabRegistry: registry });
  console.log(LOG_PREFIX, `Tab registered: ${source} -> ${tabId}`);
}

async function isTabAlive(source) {
  const registry = await getTabRegistry();
  const entry = registry[source];
  if (!entry) return false;
  try {
    await chrome.tabs.get(entry.tabId);
    return true;
  } catch {
    // Tab no longer exists — clean up registry
    registry[source] = null;
    await setState({ tabRegistry: registry });
    return false;
  }
}

async function getTabId(source) {
  const registry = await getTabRegistry();
  return registry[source]?.tabId || null;
}

/**
 * Keep a tab available without forcing its window to the foreground.
 */
async function keepTab(tabId) {
  await chrome.tabs.get(tabId);
}

/**
 * Activate a tab inside the browser without forcing the browser window to the front.
 */
async function focusTab(tabId) {
  await chrome.tabs.update(tabId, { active: true });
}

async function clickWithDebugger(tabId, rect) {
  if (!tabId) {
    throw new Error('No auth tab found for debugger click.');
  }
  if (!rect || !Number.isFinite(rect.centerX) || !Number.isFinite(rect.centerY)) {
    throw new Error('Step 6 debugger fallback needs a valid button position.');
  }

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    throw new Error(
      `Debugger attach failed during step 6 fallback: ${err.message}. ` +
      'If DevTools is open on the auth tab, close it and retry.'
    );
  }

  try {
    const x = Math.round(rect.centerX);
    const y = Math.round(rect.centerY);

    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

// ============================================================
// Command Queue (for content scripts not yet ready)
// ============================================================

const pendingCommands = new Map(); // source -> { message, resolve, reject, timer }

function queueCommand(source, message, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(source);
      const err = `Content script on ${source} did not respond in ${timeout / 1000}s. Try refreshing the tab and retry.`;
      console.error(LOG_PREFIX, err);
      reject(new Error(err));
    }, timeout);
    pendingCommands.set(source, { message, resolve, reject, timer });
    console.log(LOG_PREFIX, `Command queued for ${source} (waiting for ready)`);
  });
}

function flushCommand(source, tabId) {
  const pending = pendingCommands.get(source);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCommands.delete(source);
    chrome.tabs.sendMessage(tabId, pending.message).then(pending.resolve).catch(pending.reject);
    console.log(LOG_PREFIX, `Flushed queued command to ${source} (tab ${tabId})`);
  }
}

// ============================================================
// Wait for content script READY signal (used after page navigation)
// ============================================================

const readyWaiters = new Map(); // source -> { resolve, timer }

function waitForContentScriptReady(source, timeoutMs = 20000) {
  // If already ready, resolve immediately
  return new Promise(async (resolve, reject) => {
    const registry = await getTabRegistry();
    if (registry[source]?.ready) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      readyWaiters.delete(source);
      reject(new Error(`Content script on ${source} did not become ready within ${timeoutMs / 1000}s`));
    }, timeoutMs);

    readyWaiters.set(source, {
      resolve: () => { clearTimeout(timer); readyWaiters.delete(source); resolve(); },
    });
  });
}

function notifyContentScriptReady(source) {
  const waiter = readyWaiters.get(source);
  if (waiter) waiter.resolve();
}

// ============================================================
// Reuse or create tab
// ============================================================

function tabMatchesSource(source, tabUrl, expectedUrl = '') {
  const current = String(tabUrl || '');
  if (!current) return false;

  switch (source) {
    case 'signup-page':
      return current.includes('auth0.openai.com/')
        || current.includes('auth.openai.com/')
        || current.includes('accounts.openai.com/');
    case 'qq-mail':
      return current.includes('mail.qq.com/') || current.includes('wx.mail.qq.com/');
    case 'mail-163':
      return current.includes('mail.163.com/');
    case 'duck-email':
      return current.includes('duckduckgo.com/email/settings');
    case 'vps-panel':
      if (expectedUrl) {
        try {
          const currentUrl = new URL(current);
          const targetUrl = new URL(expectedUrl);
          return currentUrl.origin === targetUrl.origin && currentUrl.pathname === targetUrl.pathname;
        } catch {}
      }
      return false;
    default:
      return false;
  }
}

async function findExistingTabForSource(source, url = '') {
  const tabs = await chrome.tabs.query({});
  return tabs.find(tab => tabMatchesSource(source, tab.url, url)) || null;
}

async function reuseOrCreateTab(source, url, options = {}) {
  const { activate = false } = options;
  let tabId = null;

  const alive = await isTabAlive(source);
  if (alive) {
    tabId = await getTabId(source);
  } else {
    const existingTab = await findExistingTabForSource(source, url);
    if (existingTab?.id) {
      tabId = existingTab.id;
      const registry = await getTabRegistry();
      registry[source] = { tabId, ready: false };
      await setState({ tabRegistry: registry });
      console.log(LOG_PREFIX, `Adopted existing tab ${source} (${tabId})`);
    }
  }

  if (tabId) {

    // Mark as not ready BEFORE navigating — so READY signal from new page is captured correctly
    const registry = await getTabRegistry();
    if (registry[source]) registry[source].ready = false;
    await setState({ tabRegistry: registry });

    // Navigate existing tab to new URL
    await chrome.tabs.update(tabId, { url, active: activate });
    if (activate) {
      await focusTab(tabId);
    }
    console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}), navigated to ${url.slice(0, 60)}`);

    // Wait for page load complete (with 30s timeout)
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // If dynamic injection needed (VPS panel), re-inject after navigation
    if (options.inject) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: options.inject,
      });
    }

    // Wait a bit for content script to inject and send READY
    await new Promise(r => setTimeout(r, 500));

    return tabId;
  }

  // Create new tab
  const tab = await chrome.tabs.create({ url, active: activate });
  console.log(LOG_PREFIX, `Created new tab ${source} (${tab.id})`);

  // If dynamic injection needed (VPS panel), inject scripts after load
  if (options.inject) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: options.inject,
    });
  }

  return tab.id;
}

// ============================================================
// Incognito Window Management
// ============================================================

async function createIncognitoTab(source, url) {
  // Check if extension is allowed in incognito mode
  const allowed = await chrome.extension.isAllowedIncognitoAccess();
  if (!allowed) {
    throw new Error('Extension not allowed in incognito mode. Please enable it in chrome://extensions → Details → "Allow in Incognito".');
  }

  // Close existing incognito window if any
  await closeIncognitoWindow();

  // Create new incognito window
  const win = await chrome.windows.create({ url, incognito: true });
  const tab = win.tabs[0];

  await setState({ incognitoWindowId: win.id });

  // Register the tab under the given source
  const registry = await getTabRegistry();
  registry[source] = { tabId: tab.id, ready: false };
  await setState({ tabRegistry: registry });

  console.log(LOG_PREFIX, `Created incognito window ${win.id}, tab ${source} (${tab.id})`);

  // Wait for page load
  await new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  await new Promise(r => setTimeout(r, 500));
  return tab.id;
}

async function closeIncognitoWindow() {
  const state = await getState();
  if (state.incognitoWindowId) {
    try {
      await chrome.windows.remove(state.incognitoWindowId);
      console.log(LOG_PREFIX, `Closed incognito window ${state.incognitoWindowId}`);
    } catch {
      // Window already closed — ignore
    }
    await setState({ incognitoWindowId: null });
  }
}

/**
 * Close all tabs in the tab registry (except mail tabs which preserve login session).
 * @param {Object} options
 * @param {boolean} options.keepMail - If true, keep mail tabs open (default false)
 */
async function closeAllRegisteredTabs(options = {}) {
  const { keepMail = false } = options;
  const registry = await getTabRegistry();
  for (const [source, entry] of Object.entries(registry)) {
    if (!entry || !entry.tabId) continue;
    if (keepMail && (source === 'mail-163' || source === 'qq-mail')) continue;
    try {
      await chrome.tabs.remove(entry.tabId);
      console.log(LOG_PREFIX, `Closed tab: ${source} (${entry.tabId})`);
    } catch {
      // Tab already closed
    }
  }
  // Clear registry (keep mail entries if requested)
  if (keepMail) {
    const mailSources = ['mail-163', 'qq-mail'];
    const newRegistry = {};
    for (const src of mailSources) {
      if (registry[src]) newRegistry[src] = registry[src];
    }
    await setState({ tabRegistry: newRegistry });
  } else {
    await setState({ tabRegistry: {} });
  }
}

// ============================================================
// Send command to content script (with readiness check)
// ============================================================

async function sendToContentScript(source, message) {
  const registry = await getTabRegistry();
  const entry = registry[source];

  if (!entry || !entry.ready) {
    console.log(LOG_PREFIX, `${source} not ready, queuing command`);
    return queueCommand(source, message);
  }

  // Verify tab is still alive
  const alive = await isTabAlive(source);
  if (!alive) {
    // Tab was closed — queue the command, it will be sent when tab is reopened
    console.log(LOG_PREFIX, `${source} tab was closed, queuing command`);
    return queueCommand(source, message);
  }

  console.log(LOG_PREFIX, `Sending to ${source} (tab ${entry.tabId}):`, message.type);
  return chrome.tabs.sendMessage(entry.tabId, message);
}

// ============================================================
// Logging
// ============================================================

async function addLog(message, level = 'info') {
  const state = await getState();
  const logs = state.logs || [];
  const entry = { message, level, timestamp: Date.now() };
  logs.push(entry);
  // Keep last 500 logs
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await setState({ logs });
  // Broadcast to side panel
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', payload: entry }).catch(() => {});
}

function broadcastDataUpdate(payload) {
  chrome.runtime.sendMessage({ type: 'DATA_UPDATED', payload }).catch(() => {});
}

// ============================================================
// Step Status Management
// ============================================================

async function setStepStatus(step, status) {
  const state = await getState();
  const statuses = { ...state.stepStatuses };
  statuses[step] = status;
  await setState({ stepStatuses: statuses, currentStep: step });
  // Broadcast to side panel
  chrome.runtime.sendMessage({
    type: 'STEP_STATUS_CHANGED',
    payload: { step, status },
  }).catch(() => {});
}

// ============================================================
// Message Handler (central router)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG_PREFIX, `Received: ${message.type} from ${message.source || 'sidepanel'}`, message);

  handleMessage(message, sender).then(response => {
    sendResponse(response);
  }).catch(err => {
    console.error(LOG_PREFIX, 'Handler error:', err);
    sendResponse({ error: err.message });
  });

  return true; // async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CONTENT_SCRIPT_READY': {
      const tabId = sender.tab?.id;
      if (tabId && message.source) {
        await registerTab(message.source, tabId);
        flushCommand(message.source, tabId);
        notifyContentScriptReady(message.source);
        await addLog(`Content script ready: ${message.source} (tab ${tabId})`);
      }
      return { ok: true };
    }

    case 'LOG': {
      const { message: msg, level } = message.payload;
      await addLog(`[${message.source}] ${msg}`, level);
      return { ok: true };
    }

    case 'STEP_COMPLETE': {
      await setStepStatus(message.step, 'completed');
      await addLog(`Step ${message.step} completed`, 'ok');
      await handleStepData(message.step, message.payload);
      notifyStepComplete(message.step, message.payload);
      return { ok: true };
    }

    case 'STEP_ERROR': {
      await setStepStatus(message.step, 'failed');
      await addLog(`Step ${message.step} failed: ${message.error}`, 'error');
      notifyStepError(message.step, message.error);
      return { ok: true };
    }

    case 'GET_STATE': {
      return await getState();
    }

    case 'RESET': {
      await resetState();
      await addLog('Flow reset', 'info');
      return { ok: true };
    }

    case 'EXECUTE_STEP': {
      const step = message.payload.step;
      // Save email if provided (from side panel step 3)
      if (message.payload.email) {
        await setState({ email: message.payload.email });
      }
      await executeStep(step);
      return { ok: true };
    }

    case 'AUTO_RUN': {
      const totalRuns = message.payload?.totalRuns || 1;
      autoRunLoop(totalRuns);  // fire-and-forget
      return { ok: true };
    }

    case 'RESUME_AUTO_RUN': {
      if (message.payload.email) {
        await setState({ email: message.payload.email });
      }
      resumeAutoRun();  // fire-and-forget
      return { ok: true };
    }

    case 'STOP_CURRENT_TASK': {
      stopCurrentTask();  // fire-and-forget
      return { ok: true };
    }

    case 'SAVE_SETTING': {
      const currentState = await getState();
      const updates = {};
      if (message.payload.vpsUrl !== undefined) updates.vpsUrl = message.payload.vpsUrl;
      const nextProvider = message.payload.mailProvider !== undefined
        ? message.payload.mailProvider
        : currentState.mailProvider;
      let nextMailSettings = normalizeMailSettings(
        message.payload.mailSettings !== undefined ? message.payload.mailSettings : currentState.mailSettings,
        nextProvider,
        currentState.emailDomain
      );

      if (message.payload.emailDomain !== undefined) {
        nextMailSettings = normalizeMailSettings(nextMailSettings, nextProvider, currentState.emailDomain);
        nextMailSettings[nextProvider] = {
          ...nextMailSettings[nextProvider],
          emailDomain: message.payload.emailDomain,
        };
      }

      if (message.payload.mailProvider !== undefined) updates.mailProvider = nextProvider;
      if (message.payload.mailSettings !== undefined || message.payload.emailDomain !== undefined || message.payload.mailProvider !== undefined) {
        updates.mailSettings = nextMailSettings;
        updates.emailDomain = nextMailSettings[nextProvider]?.emailDomain || '';
      }
      await setState(updates);
      return { ok: true };
    }

    // Side panel data updates
    case 'SAVE_EMAIL': {
      await setState({ email: message.payload.email });
      return { ok: true };
    }

    case 'GET_ACCOUNTS': {
      return { accounts: await getAccounts() };
    }

    case 'DELETE_ACCOUNT': {
      const accounts = await deleteAccount(message.payload.index);
      return { ok: true, accounts };
    }

    case 'CLEAR_ACCOUNTS': {
      await clearAccounts();
      return { ok: true };
    }

    case 'AUTO_RUN_ACTION': {
      handleFailureAction(message.payload.action);
      return { ok: true };
    }

    default:
      console.warn(LOG_PREFIX, `Unknown message type: ${message.type}`);
      return { error: `Unknown message type: ${message.type}` };
  }
}

// ============================================================
// Step Data Handlers
// ============================================================

async function handleStepData(step, payload) {
  switch (step) {
    case 1:
      if (payload.oauthUrl) {
        await setState({ oauthUrl: payload.oauthUrl });
        // Broadcast OAuth URL to side panel
        chrome.runtime.sendMessage({
          type: 'DATA_UPDATED',
          payload: { oauthUrl: payload.oauthUrl },
        }).catch(() => {});
      }
      break;
    case 3:
      if (payload.email) await setState({ email: payload.email });
      break;
    case 4:
      if (payload.emailTimestamp) await setState({ lastEmailTimestamp: payload.emailTimestamp });
      break;
    case 6:
      if (payload.localhostUrl) {
        await setState({ localhostUrl: payload.localhostUrl, directAuthSuccess: false });
        broadcastDataUpdate({ localhostUrl: payload.localhostUrl });
      }
      break;
  }
}

// ============================================================
// Step Completion Waiting
// ============================================================

// Map of step -> { resolve, reject } for waiting on step completion
const stepWaiters = new Map();
let executionStopRequested = false;
let activeCancelableStepCleanup = null;

function waitForStepComplete(step, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stepWaiters.delete(step);
      reject(new Error(`Step ${step} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    stepWaiters.set(step, {
      resolve: (data) => { clearTimeout(timer); stepWaiters.delete(step); resolve(data); },
      reject: (err) => { clearTimeout(timer); stepWaiters.delete(step); reject(err); },
    });
  });
}

function notifyStepComplete(step, payload) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.resolve(payload);
}

function notifyStepError(step, error) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.reject(new Error(error));
}

function resetExecutionStop() {
  executionStopRequested = false;
}

function requestExecutionStop() {
  executionStopRequested = true;
}

function throwIfExecutionStopped() {
  if (executionStopRequested) {
    throw new Error('Stopped by user');
  }
}

function setActiveCancelableStepCleanup(cleanup) {
  activeCancelableStepCleanup = cleanup;
}

function clearActiveCancelableStepCleanup() {
  activeCancelableStepCleanup = null;
}

async function sleepWithStop(ms) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < ms) {
    throwIfExecutionStopped();
    await new Promise(r => setTimeout(r, Math.min(100, ms)));
  }
}

async function broadcastStopToContentScripts() {
  const registry = await getTabRegistry();
  const tabIds = new Set(
    Object.values(registry)
      .map(entry => entry?.tabId)
      .filter(tabId => Number.isInteger(tabId))
  );

  await Promise.all(
    [...tabIds].map(tabId => chrome.tabs.sendMessage(tabId, {
      type: 'STOP_EXECUTION',
      source: 'background',
      payload: {},
    }).catch(() => {}))
  );
}

// ============================================================
// Step Execution
// ============================================================

async function executeStep(step) {
  console.log(LOG_PREFIX, `Executing step ${step}`);
  resetExecutionStop();
  clearActiveCancelableStepCleanup();
  await setStepStatus(step, 'running');
  await addLog(`Step ${step} started`);

  const state = await getState();

  // Set flow start time on first step
  if (step === 1 && !state.flowStartTime) {
    await setState({ flowStartTime: Date.now() });
  }

  try {
    switch (step) {
      case 1: await executeStep1(state); break;
      case 2: await executeStep2(state); break;
      case 3: await executeStep3(state); break;
      case 4: await executeStep4(state); break;
      case 5: await executeStep5(state); break;
      case 6: await executeStep6(state); break;
      case 7: await executeStep7(state); break;
      default:
        throw new Error(`Unknown step: ${step}`);
    }
  } catch (err) {
    await setStepStatus(step, 'failed');
    await addLog(`Step ${step} failed: ${err.message}`, 'error');
    notifyStepError(step, err.message);
  } finally {
    clearActiveCancelableStepCleanup();
  }
}

/**
 * Execute a step and wait for it to complete before returning.
 * @param {number} step
 * @param {number} delayAfter - ms to wait after completion (for page transitions)
 */
async function executeStepAndWait(step, delayAfter = 2000) {
  const promise = waitForStepComplete(step, 120000);
  await executeStep(step);
  await promise;
  // Extra delay for page transitions / DOM updates
  if (delayAfter > 0) {
    await sleepWithStop(delayAfter);
  }
}

// ============================================================
// Auto Run Flow
// ============================================================

let autoRunActive = false;
let autoRunCurrentRun = 0;
let autoRunTotalRuns = 1;
let autoRunStopRequested = false;

// Outer loop: runs the full flow N times
async function autoRunLoop(totalRuns) {
  if (autoRunActive) {
    await addLog('Auto run already in progress', 'warn');
    return;
  }

  autoRunActive = true;
  autoRunStopRequested = false;
  autoRunTotalRuns = totalRuns;
  await setState({ autoRunning: true });

  for (let run = 1; run <= totalRuns; run++) {
    if (autoRunStopRequested) break;
    autoRunCurrentRun = run;

    // Close all tabs from previous run (keep mail tab to preserve login session)
    await closeAllRegisteredTabs({ keepMail: true });

    // Reset everything at the start of each run (keep VPS/mail settings)
    const prevState = await getState();
    const keepSettings = {
      vpsUrl: prevState.vpsUrl,
      mailProvider: prevState.mailProvider,
      autoRunning: true,
    };
    await resetState();
    await setState(keepSettings);
    // Tell side panel to reset all UI
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_RESET' }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));

    await addLog(`=== Auto Run ${run}/${totalRuns} — Phase 1: Get OAuth link & open auth page ===`, 'info');
    const status = (phase) => ({ type: 'AUTO_RUN_STATUS', payload: { phase, currentRun: run, totalRuns } });

    chrome.runtime.sendMessage(status('running')).catch(() => {});

    const steps = [1, 2, 3, 4, 5, 6, 7];
    let stopped = false;

    for (const step of steps) {
      if (autoRunStopRequested) {
        stopped = true;
        break;
      }
      if (step === 3) {
        await addLog(`=== Run ${run}/${totalRuns} — Phase 2: Register, verify, complete ===`, 'info');
        chrome.runtime.sendMessage(status('running')).catch(() => {});
      }

      let stepDone = false;
      while (!stepDone) {
        try {
          await executeStepAndWait(step, 2500);
          stepDone = true;
        } catch (err) {
          if (autoRunStopRequested) {
            await addLog('Auto run stop requested by user', 'warn');
            chrome.runtime.sendMessage(status('stopped')).catch(() => {});
            stopped = true;
            stepDone = true;
            break;
          }
          await addLog(`Run ${run}/${totalRuns} Step ${step} failed: ${err.message}`, 'error');

          // Pause and wait for user action (5 min timeout -> auto stop)
          const action = await waitForFailureAction(step, err.message);

          if (action === 'retry') {
            await addLog(`Step ${step}: User chose to retry`, 'info');
            chrome.runtime.sendMessage(status('running')).catch(() => {});
            // loop continues, retry the step
          } else if (action === 'skip') {
            await addLog(`Step ${step}: User chose to skip`, 'warn');
            await setStepStatus(step, 'completed');
            chrome.runtime.sendMessage(status('running')).catch(() => {});
            stepDone = true;
          } else {
            // 'stop' or timeout
            await addLog(`Auto run stopped by user (or timeout)`, 'warn');
            chrome.runtime.sendMessage(status('stopped')).catch(() => {});
            stopped = true;
            stepDone = true;
          }
        }
      }

      if (stopped) break;
    }

    if (stopped) break;
    await addLog(`=== Run ${run}/${totalRuns} COMPLETE! ===`, 'ok');
  }

  const completedRuns = autoRunCurrentRun;
  if (completedRuns >= autoRunTotalRuns) {
    await addLog(`=== All ${autoRunTotalRuns} runs completed successfully ===`, 'ok');
  } else {
    await addLog(`=== Stopped after ${completedRuns}/${autoRunTotalRuns} runs ===`, 'warn');
  }
  const finalPhase = completedRuns >= autoRunTotalRuns && !autoRunStopRequested ? 'complete' : 'stopped';
  chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: finalPhase, currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  autoRunActive = false;
  autoRunStopRequested = false;
  await setState({ autoRunning: false });
}

// Promise-based pause/resume mechanism
let resumeResolver = null;

function waitForResume() {
  return new Promise((resolve) => {
    resumeResolver = resolve;
  });
}

async function resumeAutoRun() {
  if (autoRunStopRequested) {
    await addLog('Cannot resume: stop has been requested for the current task.', 'warn');
    return;
  }
  const state = await getState();
  if (!state.email) {
    await addLog('Cannot resume: no email address. Paste email in Side Panel first.', 'error');
    return;
  }
  if (resumeResolver) {
    resumeResolver();
    resumeResolver = null;
  }
}

// Promise-based failure intervention mechanism
let failureActionResolver = null;

function waitForFailureAction(step, errorMsg, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      failureActionResolver = null;
      resolve('stop');
    }, timeoutMs);

    failureActionResolver = (action) => {
      clearTimeout(timer);
      failureActionResolver = null;
      resolve(action);
    };

    // Notify side panel to show intervention UI
    chrome.runtime.sendMessage({
      type: 'AUTO_RUN_PAUSED',
      payload: { step, error: errorMsg, timeoutMs },
    }).catch(() => {});
  });
}

function handleFailureAction(action) {
  if (failureActionResolver) {
    failureActionResolver(action);
  }
}

async function stopCurrentTask() {
  autoRunStopRequested = true;
  requestExecutionStop();
  if (activeCancelableStepCleanup) {
    try {
      activeCancelableStepCleanup();
    } catch {}
    clearActiveCancelableStepCleanup();
  }
  await broadcastStopToContentScripts();
  await closeIncognitoWindow().catch(() => {});

  const state = await getState();
  const runningStep = Object.entries(state.stepStatuses || {}).find(([, status]) => status === 'running');
  if (runningStep) {
    await setStepStatus(Number(runningStep[0]), 'failed');
    notifyStepError(Number(runningStep[0]), 'Stopped by user');
  }

  if (resumeResolver) {
    resumeResolver();
    resumeResolver = null;
  }
  if (failureActionResolver) {
    failureActionResolver('stop');
  }
  await addLog('Current task stopped by user', 'warn');
  chrome.runtime.sendMessage({
    type: 'AUTO_RUN_STATUS',
    payload: { phase: 'stopped', currentRun: autoRunCurrentRun, totalRuns: autoRunTotalRuns },
  }).catch(() => {});
  autoRunActive = false;
  await setState({ autoRunning: false });
}

// ============================================================
// Step 1: Get OAuth Link (via vps-panel.js)
// ============================================================

async function executeStep1(state) {
  if (!state.vpsUrl) {
    throw new Error('No VPS URL configured. Enter VPS address in Side Panel first.');
  }
  await addLog(`Step 1: Opening VPS panel...`);
  await reuseOrCreateTab('vps-panel', state.vpsUrl, { inject: ['content/utils.js', 'content/vps-panel.js'], activate: false });

  await sendToContentScript('vps-panel', {
    type: 'EXECUTE_STEP',
    step: 1,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 2: Open OAuth/Auth Page directly
// ============================================================

async function executeStep2(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  await addLog('Step 2: Opening OAuth URL directly...');
  await reuseOrCreateTab('signup-page', state.oauthUrl, { activate: true });

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 2,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Random Email Auto-Generation
// ============================================================

function normalizeEmailDomain(domain) {
  return String(domain || '').trim().replace(/^@+/, '').toLowerCase();
}

function generateRandomEmailAddress(domain) {
  const normalizedDomain = normalizeEmailDomain(domain);
  if (!normalizedDomain) {
    throw new Error('No email domain configured. Enter the email domain in the side panel first.');
  }

  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let localPart = 'sf';
  for (let i = 0; i < 10; i++) {
    localPart += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  localPart += Date.now().toString(36).slice(-4);

  return `${localPart}@${normalizedDomain}`;
}

// ============================================================
// Step 3: Fill Email & Password (via signup-page.js)
// ============================================================

async function executeStep3(state) {
  const email = generateRandomEmailAddress(state.emailDomain);
  await setState({ email });
  chrome.runtime.sendMessage({
    type: 'DATA_UPDATED',
    payload: { email },
  }).catch(() => {});
  await addLog(`Step 3: Generated random email: ${email}`, 'ok');

  const password = generatePassword();
  await setState({ password });

  await saveAccount({ email, password, createdAt: new Date().toISOString() });

  await addLog(`Step 3: Filling email ${email}, password generated (${password.length} chars)`);
  const signupTabId = await getTabId('signup-page');
  if (signupTabId) {
    await focusTab(signupTabId);
  }
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 3,
    source: 'background',
    payload: { email, password },
  });
}

// ============================================================
// Step 4: Get Signup Verification Code (qq-mail.js polls, then fills in signup-page.js)
// ============================================================

function getMailConfig(state) {
  const provider = state.mailProvider || 'qq';
  if (provider === '163') {
    return { source: 'mail-163', url: 'https://mail.163.com/js6/main.jsp?df=mail163_letter#module=mbox.ListModule%7C%7B%22fid%22%3A1%2C%22order%22%3A%22date%22%2C%22desc%22%3Atrue%7D', label: '163 Mail' };
  }
  return { source: 'qq-mail', url: 'https://wx.mail.qq.com/', label: 'QQ Mail' };
}

async function executeStep4(state) {
  const mail = getMailConfig(state);
  await addLog(`Step 4: Opening ${mail.label}...`);
  const alive = await isTabAlive(mail.source);
  if (alive) {
    const tabId = await getTabId(mail.source);
    await focusTab(tabId);
  } else {
    await reuseOrCreateTab(mail.source, mail.url, { activate: true });
  }

  const result = await sendToContentScript(mail.source, {
    type: 'POLL_EMAIL',
    step: 4,
    source: 'background',
    payload: {
      filterAfterTimestamp: state.flowStartTime || 0,
      senderFilters: ['openai', 'noreply', 'verify', 'auth'],
      subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm'],
      maxAttempts: 20,
      intervalMs: 3000,
    },
  });

  if (result && result.error) {
    throw new Error(result.error);
  }

  if (result && result.code) {
    await setState({ lastEmailTimestamp: result.emailTimestamp });
    await addLog(`Step 4: Got verification code: ${result.code}`);

    const signupTabId = await getTabId('signup-page');
    if (signupTabId) {
      await focusTab(signupTabId);
      await sendToContentScript('signup-page', {
        type: 'FILL_CODE',
        step: 4,
        source: 'background',
        payload: { code: result.code },
      });
    } else {
      throw new Error('Signup page tab was closed. Cannot fill verification code.');
    }
  }
}

// ============================================================
// Step 5: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep5(state) {
  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();

  await addLog(`Step 5: Generated name: ${firstName} ${lastName}, Birthday: ${year}-${month}-${day}`);

  const signupTabId = await getTabId('signup-page');
  if (signupTabId) {
    await focusTab(signupTabId);
  }
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 5,
    source: 'background',
    payload: { firstName, lastName, year, month, day },
  });
}

// ============================================================
// Step 6: Complete OAuth (webNavigation listener + consent click)
// ============================================================

let webNavListener = null;

async function executeStep6(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }

  const STEP6_RETRY_AFTER_MS = 7000;
  const STEP6_MAX_CLICK_ATTEMPTS = 2;

  await addLog('Step 6: Waiting 6s before starting...');
  await sleepWithStop(6000);
  await addLog('Step 6: Setting up localhost redirect listener...');

  // Register webNavigation listener (scoped to this step)
  return new Promise((resolve, reject) => {
    let resolved = false;
    let monitorTimer = null;
    let monitorBusy = false;
    let clickAttempts = 0;
    let lastClickAt = 0;
    let signupTabId = null;

    const cleanupListener = () => {
      if (webNavListener) {
        chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
        webNavListener = null;
      }
      if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
      }
    };

    const cancelStep = () => {
      if (resolved) return;
      resolved = true;
      cleanupListener();
      clearActiveCancelableStepCleanup();
      clearTimeout(timeout);
      reject(new Error('Stopped by user'));
    };

    setActiveCancelableStepCleanup(cancelStep);

    const finalizeStep6 = async (payload = {}) => {
      if (resolved) return;
      resolved = true;
      clearActiveCancelableStepCleanup();
      cleanupListener();
      clearTimeout(timeout);

      if (payload.localhostUrl) {
        await setState({ localhostUrl: payload.localhostUrl, directAuthSuccess: false });
        await addLog(`Step 6: Captured localhost URL: ${payload.localhostUrl}`, 'ok');
        broadcastDataUpdate({ localhostUrl: payload.localhostUrl });
      } else if (payload.successPage) {
        await setState({ directAuthSuccess: true });
        await addLog('Step 6: Success page detected on auth tab. Treating steps 6 and 7 as completed.', 'ok');
        await setStepStatus(7, 'completed');
      }

      await setStepStatus(6, 'completed');
      notifyStepComplete(6, {
        ...payload,
        directAuthSuccess: Boolean(payload.successPage && !payload.localhostUrl),
      });
      resolve();
    };

    const timeout = setTimeout(() => {
      cleanupListener();
      clearActiveCancelableStepCleanup();
      reject(new Error('Localhost redirect not captured after 120s. Step 6 click may have been blocked.'));
    }, 120000);

    webNavListener = (details) => {
      if (details.url.startsWith('http://localhost')) {
        console.log(LOG_PREFIX, `Captured localhost redirect: ${details.url}`);
        finalizeStep6({ localhostUrl: details.url }).catch(reject);
      }
    };

    chrome.webNavigation.onBeforeNavigate.addListener(webNavListener);

    const dispatchStep6Click = async (reason = 'initial') => {
      throwIfExecutionStopped();

      const clickResult = await sendToContentScript('signup-page', {
        type: 'STEP6_FIND_AND_CLICK',
        source: 'background',
        payload: {},
      });

      if (clickResult?.error) {
        throw new Error(clickResult.error);
      }

      await clickWithDebugger(signupTabId, clickResult?.rect);
      clickAttempts += 1;
      lastClickAt = Date.now();

      if (reason === 'initial') {
        await addLog('Step 6: Debugger click dispatched, waiting for redirect...');
      } else {
        await addLog(`Step 6: Retry click dispatched (${clickAttempts}/${STEP6_MAX_CLICK_ATTEMPTS}), waiting for redirect...`, 'warn');
      }
    };

    // After step 5, the auth page shows a consent screen ("使用 ChatGPT 登录到 Codex")
    // with a "继续" button. We locate the button in-page, then click it through
    // the debugger Input API directly.
    (async () => {
      try {
        throwIfExecutionStopped();
        signupTabId = await getTabId('signup-page');
        if (signupTabId) {
          await focusTab(signupTabId);
          await addLog('Step 6: Reusing auth page. Preparing debugger click...');
        } else {
          signupTabId = await reuseOrCreateTab('signup-page', state.oauthUrl, { activate: true });
          await addLog('Step 6: Auth tab reopened. Preparing debugger click...');
        }

        if (!resolved) {
          await dispatchStep6Click('initial');

          monitorTimer = setInterval(() => {
            if (resolved) return;
            if (executionStopRequested) {
              cancelStep();
              return;
            }

            if (monitorBusy) return;
            monitorBusy = true;

            (async () => {
              try {
                const currentTab = await chrome.tabs.get(signupTabId);
                const currentUrl = currentTab?.url || '';
                if (currentUrl.startsWith('http://localhost')) {
                  await finalizeStep6({ localhostUrl: currentUrl });
                  return;
                }

                const probe = await chrome.scripting.executeScript({
                  target: { tabId: signupTabId },
                  func: () => {
                    const bodyText = document.body?.innerText || '';
                    const headingText = Array.from(document.querySelectorAll('h1, h2')).map(el => el.textContent || '').join(' ');
                    return {
                      url: location.href,
                      successPage: /authentication successful!?/i.test(bodyText) || /authentication successful!?/i.test(headingText),
                    };
                  },
                }).catch(() => null);

                const result = probe?.[0]?.result;
                const probedUrl = result?.url || currentUrl;
                if (probedUrl.startsWith('http://localhost')) {
                  await finalizeStep6({ localhostUrl: probedUrl, successPage: Boolean(result?.successPage) });
                  return;
                }

                if (result?.successPage) {
                  await finalizeStep6({ successPage: true, localhostUrl: probedUrl.startsWith('http://localhost') ? probedUrl : null });
                  return;
                }

                const noReactionFor = Date.now() - lastClickAt;
                if (clickAttempts < STEP6_MAX_CLICK_ATTEMPTS && noReactionFor >= STEP6_RETRY_AFTER_MS) {
                  await addLog(`Step 6: No visible response after ${STEP6_RETRY_AFTER_MS / 1000}s, retrying click...`, 'warn');
                  await dispatchStep6Click('retry');
                }
              } catch (err) {
                if (!resolved) {
                  await addLog(`Step 6: Monitor warning: ${err.message}`, 'warn');
                }
              } finally {
                monitorBusy = false;
              }
            })();
          }, 700);
        }
      } catch (err) {
        clearTimeout(timeout);
        cleanupListener();
        clearActiveCancelableStepCleanup();
        reject(err);
      }
    })();
  });
}

// ============================================================
// Step 7: VPS Verify (via vps-panel.js)
// ============================================================

async function executeStep7(state) {
  if (state.directAuthSuccess && !state.localhostUrl) {
    await addLog('Step 7: Skipped because step 6 already reached direct authentication success page.', 'ok');
    await setStepStatus(7, 'completed');
    notifyStepComplete(7, { skipped: true, directAuthSuccess: true });
    return;
  }

  if (!state.localhostUrl) {
    throw new Error('No localhost URL. Complete step 6 first.');
  }
  if (!state.vpsUrl) {
    throw new Error('VPS URL not set. Please enter VPS URL in the side panel.');
  }

  await addLog('Step 7: Opening VPS panel...');

  let tabId = await getTabId('vps-panel');
  const alive = tabId && await isTabAlive('vps-panel');

  if (!alive) {
    const existingTab = await findExistingTabForSource('vps-panel', state.vpsUrl);
    if (existingTab?.id) {
      tabId = existingTab.id;
      const registry = await getTabRegistry();
      registry['vps-panel'] = { tabId, ready: false };
      await setState({ tabRegistry: registry });
      await chrome.tabs.update(tabId, { url: state.vpsUrl, active: true });
      await new Promise(resolve => {
        const listener = (tid, info) => {
          if (tid === tabId && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
    } else {
      throw new Error('VPS panel tab from step 1 is missing. Do not close it; rerun step 1 first.');
    }
  } else {
    await focusTab(tabId);
  }

  // Inject scripts directly and wait for them to be ready
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/utils.js', 'content/vps-panel.js'],
  });
  await new Promise(r => setTimeout(r, 1000));

  // Send command directly — bypass queue/ready mechanism
  await addLog('Step 7: Filling callback URL...');
  await chrome.tabs.sendMessage(tabId, {
    type: 'EXECUTE_STEP',
    step: 7,
    source: 'background',
    payload: { localhostUrl: state.localhostUrl },
  });
}

// ============================================================
// Open Side Panel on extension icon click
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
