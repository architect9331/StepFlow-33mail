const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createChromeStub() {
  const noop = () => {};
  const asyncNoop = async () => ({});

  return {
    storage: {
      session: {
        get: async () => ({}),
        set: asyncNoop,
        clear: asyncNoop,
      },
      local: {
        get: async () => ({}),
        set: asyncNoop,
      },
    },
    tabs: {
      query: async () => [],
      get: async (tabId) => ({ id: tabId, url: '' }),
      update: asyncNoop,
      create: async () => ({ id: 1 }),
      remove: asyncNoop,
      sendMessage: asyncNoop,
      onUpdated: {
        addListener: noop,
        removeListener: noop,
      },
    },
    windows: {
      create: async () => ({ id: 1, tabs: [{ id: 1 }] }),
      remove: asyncNoop,
    },
    extension: {
      isAllowedIncognitoAccess: async () => true,
    },
    debugger: {
      attach: asyncNoop,
      sendCommand: asyncNoop,
      detach: asyncNoop,
    },
    scripting: {
      executeScript: async () => [],
    },
    webNavigation: {
      onBeforeNavigate: {
        addListener: noop,
        removeListener: noop,
      },
    },
    runtime: {
      onMessage: {
        addListener: noop,
      },
      sendMessage: asyncNoop,
    },
    sidePanel: {
      setPanelBehavior: noop,
    },
  };
}

function loadBackgroundModule() {
  const backgroundPath = path.join(__dirname, '..', 'background.js');
  const source = fs.readFileSync(backgroundPath, 'utf8');
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    URL,
    Map,
    Set,
    Promise,
    Object,
    Array,
    Error,
    importScripts: () => {},
    chrome: createChromeStub(),
  };

  vm.createContext(context);
  vm.runInContext(
    `${source}\nthis.__testExports = { executeStep7, waitForStepComplete };`,
    context,
    { filename: 'background.js' }
  );
  return context;
}

test('Step 7 direct-auth skip should resolve waiter so auto run can continue', async () => {
  const context = loadBackgroundModule();
  const events = [];

  context.addLog = async (message, level = 'info') => {
    events.push({ type: 'log', message, level });
  };
  context.setStepStatus = async (step, status) => {
    events.push({ type: 'status', step, status });
  };

  const { executeStep7, waitForStepComplete } = context.__testExports;
  const waiter = waitForStepComplete(7, 50);

  await executeStep7({ directAuthSuccess: true, localhostUrl: null });
  await waiter;

  assert.deepEqual(events, [
    {
      type: 'log',
      message: 'Step 7: Skipped because step 6 already reached direct authentication success page.',
      level: 'ok',
    },
    {
      type: 'status',
      step: 7,
      status: 'completed',
    },
  ]);
});
