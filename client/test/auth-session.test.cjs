const assert = require('node:assert/strict');
const test = require('node:test');

test('logout clears household stores and ignores responses from the previous session', async () => {
  const [{ createPinia, setActivePinia }, { default: api }, { useAuthStore }, { useChoreStore }, { useSupplyStore }, { useLedgerStore }] = await Promise.all([
    import('pinia'),
    import('../src/utils/api.js'),
    import('../src/stores/auth.js'),
    import('../src/stores/choreStore.js'),
    import('../src/stores/supplyStore.js'),
    import('../src/stores/ledger.js')
  ]);
  const previousAdapter = api.defaults.adapter;
  const previousLocalStorage = Object.getOwnPropertyDescriptor(global, 'localStorage');
  Object.defineProperty(global, 'localStorage', {
    configurable: true,
    value: {
      getItem: key => key === 'token' ? 'test-token' : null,
      removeItem() {}
    }
  });
  const requests = [];
  api.defaults.adapter = config => new Promise(resolve => requests.push({ config, resolve }));
  setActivePinia(createPinia());

  try {
    const auth = useAuthStore();
    const chores = useChoreStore();
    const supplies = useSupplyStore();
    const ledger = useLedgerStore();

    chores.chores = [{ id: 'old-chore' }];
    supplies.supplies = [{ id: 'old-supply' }];
    supplies.members = [{ id: 'old-member' }];
    ledger.transactions = [{ id: 'old-transaction' }];
    ledger.ious = [{ id: 'old-iou' }];
    ledger.members = [{ id: 'old-ledger-member' }];
    ledger.venmoUsername = 'old-user';
    ledger.summary = { netBalance: 500 };

    const pending = [
      chores.fetchChores(),
      supplies.fetchSupplies(),
      ledger.fetchLedger()
    ];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 4);

    auth.logout();
    assert.deepEqual(chores.chores, []);
    assert.deepEqual(supplies.supplies, []);
    assert.deepEqual(supplies.members, []);
    assert.deepEqual(ledger.transactions, []);
    assert.deepEqual(ledger.ious, []);
    assert.deepEqual(ledger.members, []);
    assert.equal(ledger.venmoUsername, '');
    assert.equal(ledger.summary, null);

    for (const { config, resolve } of requests) {
      const data = {
        '/chores': [{ id: 'new-session-chore' }],
        '/supplies': { supplies: [{ id: 'new-session-supply' }], members: [] },
        '/ledger': { transactions: [{ id: 'new-session-transaction' }], ious: [], members: [], venmo_username: 'new-user' },
        '/ledger/summary': { summary: { netBalance: 900 } }
      }[config.url];
      resolve({ config, data, status: 200, statusText: 'OK', headers: {} });
    }
    await Promise.all(pending);

    assert.deepEqual(chores.chores, []);
    assert.deepEqual(supplies.supplies, []);
    assert.deepEqual(supplies.members, []);
    assert.deepEqual(ledger.transactions, []);
    assert.deepEqual(ledger.ious, []);
    assert.deepEqual(ledger.members, []);
    assert.equal(ledger.venmoUsername, '');
    assert.equal(ledger.summary, null);
    assert.equal(chores.loading, false);
    assert.equal(supplies.loading, false);
    assert.equal(ledger.loading, false);
  } finally {
    api.defaults.adapter = previousAdapter;
    if (previousLocalStorage === undefined) delete global.localStorage;
    else Object.defineProperty(global, 'localStorage', previousLocalStorage);
  }
});
