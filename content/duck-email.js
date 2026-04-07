// content/duck-email.js — DuckDuckGo Email Protection: generate private duck address

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'GENERATE_DUCK_EMAIL') return false;

  console.log(LOG_PREFIX, 'Received GENERATE_DUCK_EMAIL command');
  generateDuckEmail()
    .then(email => {
      sendResponse({ email });
    })
    .catch(err => {
      console.error(LOG_PREFIX, 'Failed to generate duck email:', err);
      sendResponse({ error: err.message });
    });

  return true; // async response
});

async function generateDuckEmail() {
  const BTN_SELECTOR = 'button.AutofillSettingsPanel__GeneratorButton';
  const INPUT_SELECTOR = 'input.AutofillSettingsPanel__PrivateDuckAddressValue';

  log('Waiting for DDG settings page to load...');

  // Wait for the generate button to appear (generous timeout for slow networks)
  let btn;
  try {
    btn = await waitForElement(BTN_SELECTOR, 15000);
  } catch (e) {
    // Page might not be the settings page (e.g. login redirect)
    log(`Generate button not found on ${location.href}, skipping`, 'warn');
    throw new Error(`Generate button not found. Current URL: ${location.href}`);
  }

  // Extra delay for React hydration — page may render elements before they're interactive
  await sleep(1500);
  log('Page loaded, reading current address...');

  // Read old address so we can detect when a new one is generated
  const input = document.querySelector(INPUT_SELECTOR);
  if (!input) {
    throw new Error('Duck address input field not found');
  }
  const oldAddress = input.value || '';
  log(`Before click — current address: "${oldAddress}"`);

  // Click generate using native .click() for React compatibility
  log('Clicking "Generate Private Duck Address"...');
  btn.click();

  // Poll for new address (different from old)
  const newAddress = await pollForNewAddress(INPUT_SELECTOR, oldAddress, 10000);
  log(`After click — new address: "${newAddress}"`, 'ok');

  return newAddress;
}

async function pollForNewAddress(selector, oldAddress, timeout) {
  const start = Date.now();
  const interval = 500;
  let lastSeen = oldAddress;

  while (Date.now() - start < timeout) {
    const input = document.querySelector(selector);
    if (input) {
      lastSeen = input.value;
      if (lastSeen && lastSeen !== oldAddress && lastSeen.includes('@duck.com')) {
        return lastSeen;
      }
    }
    await sleep(interval);
  }

  // Final check
  const input = document.querySelector(selector);
  if (input) {
    lastSeen = input.value;
    if (lastSeen && lastSeen !== oldAddress && lastSeen.includes('@duck.com')) {
      return lastSeen;
    }
  }

  throw new Error(`Duck address did not change. Old: "${oldAddress}", Last seen: "${lastSeen}". Waited ${timeout / 1000}s`);
}
