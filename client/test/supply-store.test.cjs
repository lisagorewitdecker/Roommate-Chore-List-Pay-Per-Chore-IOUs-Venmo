const assert = require('node:assert/strict');
const test = require('node:test');

function makeResponse(config, data) {
  return { data, status: 200, statusText: 'OK', headers: {}, config };
}

async function setup(adapter) {
  const [{ createPinia, setActivePinia }, { default: api }, { useSupplyStore }] = await Promise.all([
    import('pinia'),
    import('../src/utils/api.js'),
    import('../src/stores/supplyStore.js')
  ]);
  const previousAdapter = api.defaults.adapter;
  const previousLocalStorage = Object.getOwnPropertyDescriptor(global, 'localStorage');
  Object.defineProperty(global, 'localStorage', {
    configurable: true,
    value: { getItem: key => key === 'token' ? 'supply-test-token' : null }
  });
  api.defaults.adapter = adapter;
  setActivePinia(createPinia());

  return {
    store: useSupplyStore(),
    restore() {
      api.defaults.adapter = previousAdapter;
      if (previousLocalStorage === undefined) delete global.localStorage;
      else Object.defineProperty(global, 'localStorage', previousLocalStorage);
    }
  };
}

test('markPurchased sends actual cents and removes the purchased item from the active list', async () => {
  const requests = [];
  const { store, restore } = await setup(async config => {
    requests.push(config);
    return makeResponse(config, { success: true });
  });

  try {
    store.supplies.push({ id: 'supply-1', name: 'Groceries' });
    await store.markPurchased('supply-1', 1234);
    assert.deepEqual(store.supplies, []);
    assert.equal(requests[0].method, 'post');
    assert.equal(requests[0].url, '/supplies/supply-1/purchase');
    assert.equal(JSON.parse(requests[0].data).actual_price_cents, 1234);
    assert.equal(store.loading, false);
  } finally {
    restore();
  }
});

test('purchase API failures remain visible and keep the supply on the active list', async () => {
  const { store, restore } = await setup(async () => {
    const error = new Error('Purchase failed');
    error.response = { data: { error: 'Actual purchase cost must be a non-negative whole number of cents' } };
    throw error;
  });

  try {
    store.supplies.push({ id: 'supply-1', name: 'Groceries' });
    await assert.rejects(store.markPurchased('supply-1', -1), /Purchase failed/);
    assert.equal(store.error, 'Actual purchase cost must be a non-negative whole number of cents');
    assert.equal(store.supplies.length, 1);
    assert.equal(store.loading, false);
  } finally {
    restore();
  }
});

test('reset ignores supply requests started before the reset', async () => {
  const pendingRequests = [];
  const { store, restore } = await setup(config => new Promise((resolve, reject) => {
    pendingRequests.push({ config, resolve, reject });
  }));

  try {
    const request = store.fetchSupplies();
    await new Promise(resolve => setImmediate(resolve));
    store.reset();
    pendingRequests[0].resolve(makeResponse(pendingRequests[0].config, {
      supplies: [{ id: 'stale' }],
      members: [{ id: 'stale-member' }]
    }));
    await request;
    assert.deepEqual(store.supplies, []);
    assert.deepEqual(store.members, []);
    assert.equal(store.loading, false);
    assert.equal(store.error, null);

    const failedRequest = store.fetchSupplies();
    await new Promise(resolve => setImmediate(resolve));
    store.reset();
    pendingRequests[1].reject(Object.assign(new Error('stale request failed'), {
      response: { data: { error: 'Stale supply error' }, status: 500 }
    }));
    await assert.rejects(failedRequest, /stale request failed/);
    assert.deepEqual(store.supplies, []);
    assert.deepEqual(store.members, []);
    assert.equal(store.loading, false);
    assert.equal(store.error, null);
  } finally {
    restore();
  }
});