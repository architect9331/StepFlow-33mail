const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadNamesModule() {
  const namesPath = path.join(__dirname, '..', 'data', 'names.js');
  const source = fs.readFileSync(namesPath, 'utf8');
  const context = {
    Date,
    Math,
  };

  vm.createContext(context);
  vm.runInContext(
    `${source}\nthis.__testExports = {\n  generateRandomName,\n  generateRandomAge: typeof generateRandomAge === 'function' ? generateRandomAge : undefined,\n};`,
    context,
    { filename: 'data/names.js' }
  );
  return context.__testExports;
}

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
    `${source}\nthis.__testExports = { executeStep5 };`,
    context,
    { filename: 'background.js' }
  );
  return context;
}

test('年龄生成器应返回 20 到 40 之间的整数', () => {
  const { generateRandomAge } = loadNamesModule();
  assert.equal(typeof generateRandomAge, 'function');

  for (let i = 0; i < 200; i += 1) {
    const age = generateRandomAge();
    assert.equal(Number.isInteger(age), true);
    assert.ok(age >= 20 && age <= 40, `年龄超出范围: ${age}`);
  }
});

test('Step 5 应向 signup 页面发送姓名与年龄，不再发送生日字段', async () => {
  const context = loadBackgroundModule();
  const sentMessages = [];

  context.generateRandomName = () => ({ firstName: 'Jane', lastName: 'Doe' });
  context.generateRandomAge = () => 27;
  context.addLog = async () => {};
  context.getTabId = async () => 99;
  context.focusTab = async () => {};
  context.sendToContentScript = async (source, message) => {
    sentMessages.push({ source, message });
    return {};
  };

  await context.__testExports.executeStep5({});

  assert.deepEqual(JSON.parse(JSON.stringify(sentMessages)), [
    {
      source: 'signup-page',
      message: {
        type: 'EXECUTE_STEP',
        step: 5,
        source: 'background',
        payload: {
          firstName: 'Jane',
          lastName: 'Doe',
          age: 27,
        },
      },
    },
  ]);
});
