// content/signup-page.js — Content script for OpenAI auth pages (steps 2, 3, 4, 5, 6)
// Injected on: auth0.openai.com, auth.openai.com, accounts.openai.com

console.log('[MultiPage:signup-page] Content script loaded on', location.href);

// Listen for commands from Background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXECUTE_STEP' || message.type === 'FILL_CODE' || message.type === 'STEP6_FIND_AND_CLICK') {
    resetExecutionStop();
    handleCommand(message).then((result) => {
      sendResponse({ ok: true, ...(result || {}) });
    }).catch(err => {
      if (message.type === 'STEP6_FIND_AND_CLICK') {
        log(`Step 6: ${err.message}`, 'error');
        sendResponse({ error: err.message });
        return;
      }
      // Retryable errors: don't reportError (which marks step as failed)
      const retryable = err.message === 'PHONE_PAGE_DETECTED' || err.message === 'ERROR_PAGE_DETECTED';
      if (!retryable) {
        reportError(message.step, err.message);
      }
      sendResponse({ error: err.message });
    });
    return true;
  }
});

async function handleCommand(message) {
  switch (message.type) {
    case 'EXECUTE_STEP':
      switch (message.step) {
        case 2: return await step2_clickRegister();
        case 3: return await step3_fillEmailPassword(message.payload);
        case 5: return await step5_fillNameAge(message.payload);
        case 6: return await step6_findAndClick();
        default: throw new Error(`signup-page.js does not handle step ${message.step}`);
      }
    case 'FILL_CODE':
      // Step 4 = signup code
      return await fillVerificationCode(message.step, message.payload);
    case 'STEP6_FIND_AND_CLICK':
      return await step6_findAndClick();
  }
}

function isButtonEnabled(button) {
  return Boolean(button)
    && !button.disabled
    && button.getAttribute('aria-disabled') !== 'true';
}

function getSerializableRect(el) {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    throw new Error('"继续" button has no clickable size after scrolling. URL: ' + location.href);
  }

  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    centerX: rect.left + (rect.width / 2),
    centerY: rect.top + (rect.height / 2),
  };
}

async function waitForButtonEnabled(button, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (isButtonEnabled(button)) return;
    await sleep(150);
  }
  throw new Error('"继续" button stayed disabled for too long. URL: ' + location.href);
}

async function findContinueButton() {
  try {
    return await waitForElement(
      'button[type="submit"][data-dd-action-name="Continue"], button[type="submit"]._primary_3rdp0_107',
      10000
    );
  } catch {
    try {
      return await waitForElementByText('button', /继续|Continue/, 5000);
    } catch {
      throw new Error('Could not find "继续" button on OAuth consent page. URL: ' + location.href);
    }
  }
}

async function step6_findAndClick() {
  log('Step 6: Looking for OAuth consent "继续" button...');

  const continueBtn = await findContinueButton();
  await waitForButtonEnabled(continueBtn);

  continueBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  continueBtn.focus();
  await sleep(250);

  const rect = getSerializableRect(continueBtn);
  log('Step 6: Found "继续" button and prepared debugger click coordinates.');
  return {
    rect,
    buttonText: (continueBtn.textContent || '').trim(),
    url: location.href,
  };
}

// ============================================================
// Step 2: Click Register
// ============================================================

async function step2_clickRegister() {
  log('Step 2: Looking for Register/Sign up button...');

  let registerBtn = null;
  try {
    registerBtn = await waitForElementByText(
      'a, button, [role="button"], [role="link"]',
      /sign\s*up|register|create\s*account|注册/i,
      10000
    );
  } catch {
    // Some pages may have a direct link
    try {
      registerBtn = await waitForElement('a[href*="signup"], a[href*="register"]', 5000);
    } catch {
      throw new Error(
        'Could not find Register/Sign up button. ' +
        'Check auth page DOM in DevTools. URL: ' + location.href
      );
    }
  }

  log('Step 2: Found Register button, waiting before click...');
  await sleep(2500);
  reportComplete(2);
  simulateClick(registerBtn);
  log('Step 2: Clicked Register button');
}

// ============================================================
// Step 3: Fill Email & Password
// ============================================================

async function step3_fillEmailPassword(payload) {
  const { email } = payload;
  if (!email) throw new Error('No email provided. Paste email in Side Panel first.');

  log(`Step 3: Filling email: ${email}`);

  // Find email input
  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email"], input[placeholder*="Email"]',
      10000
    );
  } catch {
    throw new Error('Could not find email input field on signup page. URL: ' + location.href);
  }

  await slowType(emailInput, email, 60);
  log('Step 3: Email filled');
  await sleep(800);

  // Check if password field is on the same page
  let passwordInput = document.querySelector('input[type="password"]');

  if (!passwordInput) {
    // Need to submit email first to get to password page
    log('Step 3: No password field yet, submitting email first...');
    const submitBtn = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);

    if (submitBtn) {
      simulateClick(submitBtn);
      log('Step 3: Submitted email, waiting for password field...');
      await sleep(2000);
    }

    try {
      passwordInput = await waitForElement('input[type="password"]', 10000);
    } catch {
      throw new Error('Could not find password input after submitting email. URL: ' + location.href);
    }
  }

  if (!payload.password) throw new Error('No password provided. Step 3 requires a generated password.');
  await slowType(passwordInput, payload.password, 80);
  log('Step 3: Password filled');

  // Report complete BEFORE submit, because submit causes page navigation
  // which kills the content script connection
  log('Step 3: Form filled, pausing to show result...');
  await sleep(2500);
  reportComplete(3, { email });

  // Submit the form (page will navigate away after this)
  await sleep(500);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|sign\s*up|submit|注册|创建|create/i, 5000).catch(() => null);

  if (submitBtn) {
    simulateClick(submitBtn);
    log('Step 3: Form submitted');
  }
}

// ============================================================
// Fill Verification Code (used by step 4)
// ============================================================

async function fillVerificationCode(step, payload) {
  const { code } = payload;
  if (!code) throw new Error('No verification code provided.');

  log(`Step ${step}: Filling verification code: ${code}`);

  // Find code input — could be a single input or multiple separate inputs
  let codeInput = null;
  try {
    codeInput = await waitForElement(
      'input[name="code"], input[name="otp"], input[type="text"][maxlength="6"], input[aria-label*="code"], input[placeholder*="code"], input[placeholder*="Code"], input[inputmode="numeric"]',
      10000
    );
  } catch {
    // Check for multiple single-digit inputs (common pattern)
    const singleInputs = document.querySelectorAll('input[maxlength="1"]');
    if (singleInputs.length >= 6) {
      log(`Step ${step}: Found single-digit code inputs, filling individually...`);
      for (let i = 0; i < 6 && i < singleInputs.length; i++) {
        fillInput(singleInputs[i], code[i]);
        await sleep(100);
      }
      log(`Step ${step}: Code filled in single-digit inputs, pausing...`);
      await sleep(2500);
      reportComplete(step);
      return;
    }
    throw new Error('Could not find verification code input. URL: ' + location.href);
  }

  await slowType(codeInput, code, 150);
  log(`Step ${step}: Code filled, pausing to show result...`);

  // Report complete BEFORE submit (page may navigate away)
  await sleep(2500);
  reportComplete(step);

  // Submit
  await sleep(500);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /verify|confirm|submit|continue|确认|验证/i, 5000).catch(() => null);

  if (submitBtn) {
    simulateClick(submitBtn);
    log(`Step ${step}: Verification submitted`);
  }
}

// ============================================================
// Step 5：填写姓名与年龄
// ============================================================

async function step5_fillNameAge(payload) {
  const { firstName, lastName, age } = payload;
  if (!firstName || !lastName) throw new Error('No name data provided.');
  if (!Number.isInteger(age)) throw new Error('No valid age provided.');

  const fullName = `${firstName} ${lastName}`;
  log(`Step 5: Filling name: ${fullName}, Age: ${age}`);

  let nameInput = null;
  try {
    nameInput = await waitForElement(
      'input[name="name"], input[placeholder*="全名"], input[autocomplete="name"]',
      10000
    );
  } catch {
    throw new Error('Could not find name input. URL: ' + location.href);
  }
  await slowType(nameInput, fullName, 80);
  log(`Step 5: Name filled: ${fullName}`);
  await sleep(800);

  const ageSelector = [
    'input[name="age"]',
    'input[name*="age" i]',
    'input[id*="age" i]',
    'input[placeholder*="age" i]',
    'input[placeholder*="年龄"]',
    'input[aria-label*="age" i]',
    'input[aria-label*="年龄"]',
    'input[type="number"]',
    'input[inputmode="numeric"]',
  ].join(', ');

  let ageInput = null;
  try {
    ageInput = await waitForElement(ageSelector, 10000);
  } catch {
    const candidates = Array.from(document.querySelectorAll('input')).filter((input) => {
      if (input === nameInput || input.disabled || input.readOnly) return false;
      if (input.type === 'hidden' || input.type === 'email' || input.type === 'password') return false;

      const descriptor = [
        input.name,
        input.id,
        input.placeholder,
        input.getAttribute('aria-label'),
        input.autocomplete,
        input.inputMode,
        input.type,
      ].filter(Boolean).join(' ').toLowerCase();

      return descriptor.includes('age')
        || descriptor.includes('年龄')
        || input.type === 'number'
        || input.inputMode === 'numeric';
    });

    ageInput = candidates[0] || null;
  }

  if (!ageInput) {
    throw new Error('Could not find age input. URL: ' + location.href);
  }

  await slowType(ageInput, String(age), 80);
  log(`Step 5: Age filled: ${age}`);

  await sleep(500);
  const completeBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /完成|create|continue|finish|done|agree/i, 5000).catch(() => null);

  log('Step 5: Name & age filled, pausing to show result...');
  await sleep(2500);
  reportComplete(5);

  if (completeBtn) {
    simulateClick(completeBtn);
    log('Step 5: Clicked "完成帐户创建"');
  }
}
