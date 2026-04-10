// sidepanel/sidepanel.js — Side Panel logic

const STATUS_ICONS = {
  pending: '',
  running: '',
  completed: '\u2713',  // ✓
  failed: '\u2717',     // ✗
};

const logArea = document.getElementById('log-area');
const displayOauthUrl = document.getElementById('display-oauth-url');
const displayLocalhostUrl = document.getElementById('display-localhost-url');
const displayStatus = document.getElementById('display-status');
const statusBar = document.getElementById('status-bar');
const inputEmail = document.getElementById('input-email');
const btnReset = document.getElementById('btn-reset');
const stepsProgress = document.getElementById('steps-progress');
const btnAutoRun = document.getElementById('btn-auto-run');
const btnStopRun = document.getElementById('btn-stop-run');
const btnAutoContinue = document.getElementById('btn-auto-continue');
const autoContinueBar = document.getElementById('auto-continue-bar');
const btnClearLog = document.getElementById('btn-clear-log');
const inputVpsUrl = document.getElementById('input-vps-url');
const inputRunCount = document.getElementById('input-run-count');
const failureBar = document.getElementById('failure-intervention-bar');
const failureMsg = document.getElementById('failure-msg');
const failureCountdown = document.getElementById('failure-countdown');
const btnFailureRetry = document.getElementById('btn-failure-retry');
const btnFailureSkip = document.getElementById('btn-failure-skip');
const btnFailureStop = document.getElementById('btn-failure-stop');
const mailGroups = [...document.querySelectorAll('.mail-group')];
const mailGroupToggles = [...document.querySelectorAll('.mail-group-top')];
const mailDomainInputs = [...document.querySelectorAll('.mail-domain-input')];
const profileModeToggles = [...document.querySelectorAll('.mode-toggle-btn')];

let failureCountdownTimer = null;
let currentMailProvider = '163';
let mailSettingsState = createDefaultMailSettings();
let currentProfileMode = 'birthday';

function createDefaultMailSettings() {
  return {
    '163': { emailDomain: '' },
    qq: { emailDomain: '' },
  };
}

function normalizeMailSettings(rawSettings, activeProvider = '163', legacyEmailDomain = '') {
  const settings = createDefaultMailSettings();
  for (const provider of Object.keys(settings)) {
    const rawDomain = rawSettings?.[provider]?.emailDomain;
    settings[provider].emailDomain = typeof rawDomain === 'string' ? rawDomain : '';
  }
  if (legacyEmailDomain && !settings[activeProvider]?.emailDomain) {
    settings[activeProvider].emailDomain = legacyEmailDomain;
  }
  return settings;
}

function normalizeProfileMode(mode) {
  return mode === 'age' ? 'age' : 'birthday';
}

function renderMailGroups({ mailProvider, mailSettings, emailDomain } = {}) {
  currentMailProvider = mailProvider || currentMailProvider;
  mailSettingsState = normalizeMailSettings(mailSettings, currentMailProvider, emailDomain || '');

  mailGroups.forEach(group => {
    const provider = group.dataset.provider;
    const isActive = provider === currentMailProvider;
    group.classList.toggle('active', isActive);
    const badge = group.querySelector('.mail-group-badge');
    if (badge) {
      badge.textContent = isActive ? 'Active' : 'Use';
    }
  });

  mailDomainInputs.forEach(input => {
    const provider = input.dataset.provider;
    input.value = mailSettingsState[provider]?.emailDomain || '';
  });
}

function collectMailSettingsFromInputs() {
  const nextSettings = createDefaultMailSettings();
  mailDomainInputs.forEach(input => {
    const provider = input.dataset.provider;
    nextSettings[provider].emailDomain = input.value.trim();
  });
  return nextSettings;
}

function renderProfileMode(mode = 'birthday') {
  currentProfileMode = normalizeProfileMode(mode);
  profileModeToggles.forEach(toggle => {
    toggle.classList.toggle('active', toggle.dataset.profileMode === currentProfileMode);
  });
}

// ============================================================
// Toast Notifications
// ============================================================

const toastContainer = document.getElementById('toast-container');

const TOAST_ICONS = {
  error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  warn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

function showToast(message, type = 'error', duration = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `${TOAST_ICONS[type] || ''}<span class="toast-msg">${escapeHtml(message)}</span><button class="toast-close">&times;</button>`;

  toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(toast));
  toastContainer.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => dismissToast(toast), duration);
  }
}

function dismissToast(toast) {
  if (!toast.parentNode) return;
  toast.classList.add('toast-exit');
  toast.addEventListener('animationend', () => toast.remove());
}

// ============================================================
// State Restore on load
// ============================================================

async function restoreState() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' });

    if (state.oauthUrl) {
      displayOauthUrl.textContent = state.oauthUrl;
      displayOauthUrl.classList.add('has-value');
    }
    if (state.localhostUrl) {
      displayLocalhostUrl.textContent = state.localhostUrl;
      displayLocalhostUrl.classList.add('has-value');
    }
    if (state.email) {
      inputEmail.value = state.email;
    }
    renderMailGroups(state);
    renderProfileMode(state.profileMode);
    if (state.vpsUrl) {
      inputVpsUrl.value = state.vpsUrl;
    } else if (inputVpsUrl.value) {
      // Sync HTML default value to background on first load
      await chrome.runtime.sendMessage({ type: 'SAVE_SETTING', source: 'sidepanel', payload: { vpsUrl: inputVpsUrl.value } });
    }

    if (state.stepStatuses) {
      for (const [step, status] of Object.entries(state.stepStatuses)) {
        updateStepUI(Number(step), status);
      }
    }

    if (state.logs) {
      for (const entry of state.logs) {
        appendLog(entry);
      }
    }

    updateStatusDisplay(state);
    updateProgressCounter();
  } catch (err) {
    console.error('Failed to restore state:', err);
  }
}

// ============================================================
// UI Updates
// ============================================================

function updateStepUI(step, status) {
  const statusEl = document.querySelector(`.step-status[data-step="${step}"]`);
  const row = document.querySelector(`.step-row[data-step="${step}"]`);

  if (statusEl) statusEl.textContent = STATUS_ICONS[status] || '';
  if (row) {
    row.className = `step-row ${status}`;
  }

  updateButtonStates();
  updateProgressCounter();
}

function updateProgressCounter() {
  let completed = 0;
  const visibleRows = [...document.querySelectorAll('.step-row')].filter(row => row.offsetParent !== null);
  visibleRows.forEach(row => {
    if (row.classList.contains('completed')) completed++;
  });
  stepsProgress.textContent = `${completed} / ${visibleRows.length}`;
}

function updateButtonStates() {
  const statuses = {};
  const visibleRows = [...document.querySelectorAll('.step-row')].filter(row => row.offsetParent !== null);
  visibleRows.forEach(row => {
    const step = Number(row.dataset.step);
    if (row.classList.contains('completed')) statuses[step] = 'completed';
    else if (row.classList.contains('running')) statuses[step] = 'running';
    else if (row.classList.contains('failed')) statuses[step] = 'failed';
    else statuses[step] = 'pending';
  });

  const anyRunning = Object.values(statuses).some(s => s === 'running');
  const orderedSteps = visibleRows.map(row => Number(row.dataset.step));

  for (const step of orderedSteps) {
    const btn = document.querySelector(`.step-btn[data-step="${step}"]`);
    if (!btn) continue;

    btn.disabled = anyRunning;
  }
}

function updateStatusDisplay(state) {
  if (!state || !state.stepStatuses) return;

  statusBar.className = 'status-bar';

  const running = Object.entries(state.stepStatuses).find(([, s]) => s === 'running');
  if (running) {
    displayStatus.textContent = `Step ${running[0]} running...`;
    statusBar.classList.add('running');
    return;
  }

  const failed = Object.entries(state.stepStatuses).find(([, s]) => s === 'failed');
  if (failed) {
    displayStatus.textContent = `Step ${failed[0]} failed`;
    statusBar.classList.add('failed');
    return;
  }

  const lastCompleted = Object.entries(state.stepStatuses)
    .filter(([, s]) => s === 'completed')
    .map(([k]) => Number(k))
    .sort((a, b) => b - a)[0];

  if (lastCompleted === 7) {
    displayStatus.textContent = 'All steps completed!';
    statusBar.classList.add('completed');
  } else if (lastCompleted) {
    displayStatus.textContent = `Step ${lastCompleted} done`;
  } else {
    displayStatus.textContent = 'Ready';
  }
}

function appendLog(entry) {
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
  const levelLabel = entry.level.toUpperCase();
  const line = document.createElement('div');
  line.className = `log-line log-${entry.level}`;

  const stepMatch = entry.message.match(/Step (\d)/);
  const stepNum = stepMatch ? stepMatch[1] : null;

  let html = `<span class="log-time">${time}</span> `;
  html += `<span class="log-level log-level-${entry.level}">${levelLabel}</span> `;
  if (stepNum) {
    html += `<span class="log-step-tag step-${stepNum}">S${stepNum}</span>`;
  }
  html += `<span class="log-msg">${escapeHtml(entry.message)}</span>`;

  line.innerHTML = html;
  logArea.appendChild(line);
  logArea.scrollTop = logArea.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================
// Button Handlers
// ============================================================

document.querySelectorAll('.step-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const step = Number(btn.dataset.step);
    if (step === 3) {
      await chrome.runtime.sendMessage({
        type: 'EXECUTE_STEP', source: 'sidepanel',
        payload: { step },
      });
    } else {
      await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step } });
    }
  });
});

// Auto Run
btnAutoRun.addEventListener('click', async () => {
  const totalRuns = parseInt(inputRunCount.value) || 1;
  btnAutoRun.disabled = true;
  btnStopRun.disabled = false;
  inputRunCount.disabled = true;
  btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Running...';
  await chrome.runtime.sendMessage({ type: 'AUTO_RUN', source: 'sidepanel', payload: { totalRuns } });
});

btnStopRun.addEventListener('click', async () => {
  btnStopRun.disabled = true;
  await chrome.runtime.sendMessage({ type: 'STOP_CURRENT_TASK', source: 'sidepanel', payload: {} });
});

btnAutoContinue.addEventListener('click', async () => {
  autoContinueBar.style.display = 'none';
  await chrome.runtime.sendMessage({ type: 'RESUME_AUTO_RUN', source: 'sidepanel', payload: {} });
});

// Failure intervention buttons
function sendFailureAction(action) {
  hideFailureBar();
  chrome.runtime.sendMessage({ type: 'AUTO_RUN_ACTION', source: 'sidepanel', payload: { action } });
}

function hideFailureBar() {
  failureBar.style.display = 'none';
  if (failureCountdownTimer) {
    clearInterval(failureCountdownTimer);
    failureCountdownTimer = null;
  }
}

function showFailureBar(step, errorMsg, timeoutMs) {
  failureMsg.textContent = `Step ${step} failed: ${errorMsg}`;
  failureMsg.title = `Step ${step} failed: ${errorMsg}`;
  failureBar.style.display = '';

  // Countdown
  let remaining = Math.ceil(timeoutMs / 1000);
  const updateCountdown = () => {
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    failureCountdown.textContent = `${min}:${String(sec).padStart(2, '0')}`;
  };
  updateCountdown();

  failureCountdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      hideFailureBar();
      return;
    }
    updateCountdown();
  }, 1000);
}

btnFailureRetry.addEventListener('click', () => sendFailureAction('retry'));
btnFailureSkip.addEventListener('click', () => sendFailureAction('skip'));
btnFailureStop.addEventListener('click', () => sendFailureAction('stop'));

// Reset
btnReset.addEventListener('click', async () => {
  if (confirm('Reset all steps and data?')) {
    await chrome.runtime.sendMessage({ type: 'RESET', source: 'sidepanel' });
    displayOauthUrl.textContent = 'Waiting...';
    displayOauthUrl.classList.remove('has-value');
    displayLocalhostUrl.textContent = 'Waiting...';
    displayLocalhostUrl.classList.remove('has-value');
    inputEmail.value = '';
    displayStatus.textContent = 'Ready';
    statusBar.className = 'status-bar';
    logArea.innerHTML = '';
    document.querySelectorAll('.step-row').forEach(row => row.className = 'step-row');
    document.querySelectorAll('.step-status').forEach(el => el.textContent = '');
    btnAutoRun.disabled = false;
    btnStopRun.disabled = true;
    btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Auto';
    autoContinueBar.style.display = 'none';
    hideFailureBar();
    updateButtonStates();
    updateProgressCounter();
  }
});

// Clear log
btnClearLog.addEventListener('click', () => {
  logArea.innerHTML = '';
});

// Save settings on change
inputEmail.addEventListener('change', async () => {
  const email = inputEmail.value.trim();
  if (email) {
    await chrome.runtime.sendMessage({ type: 'SAVE_EMAIL', source: 'sidepanel', payload: { email } });
  }
});

inputVpsUrl.addEventListener('change', async () => {
  const vpsUrl = inputVpsUrl.value.trim();
  if (vpsUrl) {
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTING', source: 'sidepanel', payload: { vpsUrl } });
  }
});

mailDomainInputs.forEach(input => {
  input.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  input.addEventListener('change', async () => {
    const provider = input.dataset.provider;
    const mailSettings = collectMailSettingsFromInputs();
    mailSettingsState = normalizeMailSettings(mailSettings, currentMailProvider);
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTING',
      source: 'sidepanel',
      payload: { mailSettings },
    });

    if (provider === currentMailProvider) {
      renderMailGroups({ mailProvider: currentMailProvider, mailSettings: mailSettingsState });
    }
  });
});

mailGroupToggles.forEach(toggle => {
  toggle.addEventListener('click', async () => {
    const provider = toggle.dataset.provider;
    currentMailProvider = provider;
    const mailSettings = collectMailSettingsFromInputs();
    renderMailGroups({ mailProvider: provider, mailSettings });
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTING',
      source: 'sidepanel',
      payload: { mailProvider: provider, mailSettings },
    });
  });
});

profileModeToggles.forEach(toggle => {
  toggle.addEventListener('click', async () => {
    const profileMode = normalizeProfileMode(toggle.dataset.profileMode);
    renderProfileMode(profileMode);
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTING',
      source: 'sidepanel',
      payload: { profileMode },
    });
  });
});

// ============================================================
// Listen for Background broadcasts
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'LOG_ENTRY':
      appendLog(message.payload);
      if (message.payload.level === 'error') {
        showToast(message.payload.message, 'error');
      }
      break;

    case 'ACCOUNT_ADDED':
      loadAccounts();
      break;

    case 'STEP_STATUS_CHANGED': {
      const { step, status } = message.payload;
      updateStepUI(step, status);
      chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then(updateStatusDisplay);
      if (status === 'completed') {
        chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then(state => {
          if (state.oauthUrl) {
            displayOauthUrl.textContent = state.oauthUrl;
            displayOauthUrl.classList.add('has-value');
          }
          if (state.localhostUrl) {
            displayLocalhostUrl.textContent = state.localhostUrl;
            displayLocalhostUrl.classList.add('has-value');
          }
        });
      }
      break;
    }

    case 'AUTO_RUN_RESET': {
      // Full UI reset for next run
      displayOauthUrl.textContent = 'Waiting...';
      displayOauthUrl.classList.remove('has-value');
      displayLocalhostUrl.textContent = 'Waiting...';
      displayLocalhostUrl.classList.remove('has-value');
      inputEmail.value = '';
      displayStatus.textContent = 'Ready';
      statusBar.className = 'status-bar';
      logArea.innerHTML = '';
      document.querySelectorAll('.step-row').forEach(row => row.className = 'step-row');
      document.querySelectorAll('.step-status').forEach(el => el.textContent = '');
      hideFailureBar();
      btnStopRun.disabled = true;
      updateProgressCounter();
      break;
    }

    case 'AUTO_RUN_PAUSED': {
      const { step, error, timeoutMs } = message.payload;
      showFailureBar(step, error, timeoutMs);
      break;
    }

    case 'DATA_UPDATED': {
      if (message.payload.oauthUrl) {
        displayOauthUrl.textContent = message.payload.oauthUrl;
        displayOauthUrl.classList.add('has-value');
      }
      if (message.payload.localhostUrl) {
        displayLocalhostUrl.textContent = message.payload.localhostUrl;
        displayLocalhostUrl.classList.add('has-value');
      }
      if (message.payload.email) {
        inputEmail.value = message.payload.email;
      }
      break;
    }

    case 'AUTO_RUN_STATUS': {
      const { phase, currentRun, totalRuns } = message.payload;
      const runLabel = totalRuns > 1 ? ` (${currentRun}/${totalRuns})` : '';
      switch (phase) {
        case 'running':
          btnStopRun.disabled = false;
          btnAutoRun.innerHTML = `Running${runLabel}`;
          break;
        case 'complete':
          btnAutoRun.disabled = false;
          btnStopRun.disabled = true;
          inputRunCount.disabled = false;
          btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Auto';
          autoContinueBar.style.display = 'none';
          hideFailureBar();
          break;
        case 'stopped':
          btnAutoRun.disabled = false;
          btnStopRun.disabled = true;
          inputRunCount.disabled = false;
          btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Auto';
          autoContinueBar.style.display = 'none';
          hideFailureBar();
          break;
      }
      break;
    }
  }
});

// ============================================================
// Theme Toggle
// ============================================================

const btnTheme = document.getElementById('btn-theme');

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('stepflow-33mail-theme', theme);
}

function initTheme() {
  const saved = localStorage.getItem('stepflow-33mail-theme')
    || localStorage.getItem('stepflow-codex-theme')
    || localStorage.getItem('stepflow-duck-theme');
  if (saved) {
    setTheme(saved);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    setTheme('dark');
  }
}

btnTheme.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

// ============================================================
// Accounts Management
// ============================================================

const accountsList = document.getElementById('accounts-list');
const accountsCount = document.getElementById('accounts-count');
const btnExportAccounts = document.getElementById('btn-export-accounts');
const btnClearAccounts = document.getElementById('btn-clear-accounts');
const btnToggleAccounts = document.getElementById('btn-toggle-accounts');

let accountsCollapsed = false;

function renderAccountRow(account, index) {
  const row = document.createElement('div');
  row.className = 'account-row';
  row.dataset.index = index;

  const time = new Date(account.createdAt).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });

  const copySvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

  row.innerHTML = `
    <div class="account-info">
      <span class="account-email" title="${escapeHtml(account.email)}">${escapeHtml(account.email)}</span>
      <button class="btn-icon btn-copy-inline" data-action="copy-email" title="Copy email">${copySvg}</button>
      <span class="account-pwd" data-hidden="true" title="Click to reveal">••••••••</span>
      <button class="btn-icon btn-copy-inline" data-action="copy-pwd" title="Copy password">${copySvg}</button>
      <span class="account-time">${time}</span>
    </div>
    <div class="account-actions">
      <button class="btn-icon" data-action="copy" title="Copy email:password">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
      <button class="btn-icon" data-action="delete" title="Delete">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>
  `;

  // Toggle password visibility
  const pwdEl = row.querySelector('.account-pwd');
  pwdEl.addEventListener('click', () => {
    if (pwdEl.dataset.hidden === 'true') {
      pwdEl.textContent = account.password;
      pwdEl.dataset.hidden = 'false';
    } else {
      pwdEl.textContent = '••••••••';
      pwdEl.dataset.hidden = 'true';
    }
  });

  // Copy email
  row.querySelector('[data-action="copy-email"]').addEventListener('click', () => {
    navigator.clipboard.writeText(account.email).then(() => {
      showToast('Email copied', 'success', 2000);
    });
  });

  // Copy password
  row.querySelector('[data-action="copy-pwd"]').addEventListener('click', () => {
    navigator.clipboard.writeText(account.password).then(() => {
      showToast('Password copied', 'success', 2000);
    });
  });

  // Copy email:password
  row.querySelector('[data-action="copy"]').addEventListener('click', () => {
    navigator.clipboard.writeText(`${account.email}:${account.password}`).then(() => {
      showToast('Copied to clipboard', 'success', 2000);
    });
  });

  // Delete
  row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    const result = await chrome.runtime.sendMessage({
      type: 'DELETE_ACCOUNT', source: 'sidepanel', payload: { index },
    });
    if (result.ok) {
      loadAccounts();
    }
  });

  return row;
}

async function loadAccounts() {
  const result = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNTS', source: 'sidepanel' });
  const accounts = result.accounts || [];
  accountsList.innerHTML = '';
  // Display in reverse order (newest first), but keep original index for delete
  for (let i = accounts.length - 1; i >= 0; i--) {
    accountsList.appendChild(renderAccountRow(accounts[i], i));
  }
  accountsCount.textContent = accounts.length;
}

btnToggleAccounts.addEventListener('click', () => {
  accountsCollapsed = !accountsCollapsed;
  accountsList.style.display = accountsCollapsed ? 'none' : '';
  btnToggleAccounts.querySelector('.chevron-icon').style.transform =
    accountsCollapsed ? 'rotate(-90deg)' : '';
});

btnExportAccounts.addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNTS', source: 'sidepanel' });
  const accounts = result.accounts || [];
  if (accounts.length === 0) {
    showToast('No accounts to export', 'warn');
    return;
  }
  const json = JSON.stringify(accounts, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = url;
  a.download = `accounts-${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${accounts.length} accounts`, 'success', 2000);
});

btnClearAccounts.addEventListener('click', async () => {
  if (!confirm('Clear all saved accounts?')) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR_ACCOUNTS', source: 'sidepanel' });
  loadAccounts();
  showToast('Accounts cleared', 'info', 2000);
});

// ============================================================
// Init
// ============================================================

initTheme();
renderMailGroups({ mailProvider: currentMailProvider, mailSettings: mailSettingsState });
renderProfileMode(currentProfileMode);
restoreState().then(() => {
  updateButtonStates();
});
loadAccounts();
