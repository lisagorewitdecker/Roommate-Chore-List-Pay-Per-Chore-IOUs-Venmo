const assert = require('node:assert/strict');
const test = require('node:test');

function makeResponse(config, data) {
  return { data, status: 200, statusText: 'OK', headers: {}, config };
}

async function setup(adapter) {
  const [{ createPinia, setActivePinia }, { default: api }, { useLedgerStore }] = await Promise.all([
    import('pinia'),
    import('../src/utils/api.js'),
    import('../src/stores/ledger.js')
  ]);
  const previousAdapter = api.defaults.adapter;
  const previousLocalStorage = Object.getOwnPropertyDescriptor(global, 'localStorage');
  Object.defineProperty(global, 'localStorage', {
    configurable: true,
    value: { getItem: key => key === 'token' ? 'ledger-test-token' : null }
  });
  api.defaults.adapter = adapter;
  setActivePinia(createPinia());

  return {
    api,
    store: useLedgerStore(),
    restore() {
      api.defaults.adapter = previousAdapter;
      if (previousLocalStorage === undefined) delete global.localStorage;
      else Object.defineProperty(global, 'localStorage', previousLocalStorage);
    }
  };
}

test('fetchLedger loads wallet history, IOUs, members, and summary from the ledger API', async () => {
  const configs = [];
  const { store, restore } = await setup(async config => {
    configs.push(config);
    if (config.url === '/ledger') {
      return makeResponse(config, {
        transactions: [{ id: 'wallet-payment', amount_cents: 750 }],
        ious: [{ id: 'iou-1', amount_cents: 1200 }],
        members: [{ id: 'roommate', name: 'Roommate', venmo_username: 'roommate-pay' }],
        venmo_username: 'current-roommate'
      });
    }
    return makeResponse(config, { summary: { owedToMe: 1200, iOweOthers: 0, netBalance: 1200 } });
  });

  try {
    await store.fetchLedger();
    assert.deepEqual(store.transactions, [{ id: 'wallet-payment', amount_cents: 750 }]);
    assert.deepEqual(store.ious, [{ id: 'iou-1', amount_cents: 1200 }]);
    assert.deepEqual(store.members, [{ id: 'roommate', name: 'Roommate', venmo_username: 'roommate-pay' }]);
    assert.equal(store.venmoUsername, 'current-roommate');
    assert.deepEqual(store.summary, { owedToMe: 1200, iOweOthers: 0, netBalance: 1200 });
    assert.deepEqual(configs.map(config => config.url).sort(), ['/ledger', '/ledger/summary']);
    assert.ok(configs.every(config => config.headers.Authorization === 'Bearer ledger-test-token'));
    assert.equal(store.loading, false);
  } finally {
    restore();
  }
});

test('createIOU, markPaid, and Venmo profile updates call their endpoints', async () => {
  const requests = [];
  const createdIou = { id: 'new-iou', status: 'pending', amount_cents: 425 };
  const paidIou = { ...createdIou, status: 'paid' };
  const { store, restore } = await setup(async config => {
    requests.push({ method: config.method, url: config.url, data: config.data });
    if (config.url === '/ledger/venmo') return makeResponse(config, { venmo_username: 'roommate-pay' });
    return makeResponse(config, { iou: config.method === 'post' ? createdIou : paidIou });
  });

  try {
    const created = await store.createIOU({ debtor_id: 'debtor', creditor_id: 'creditor', amount_cents: 425 });
    assert.deepEqual(created, createdIou);
    assert.deepEqual(store.ious, [createdIou]);
    const paid = await store.markPaid(createdIou.id);
    assert.deepEqual(paid, paidIou);
    assert.deepEqual(store.ious, [paidIou]);
    assert.deepEqual(requests.map(request => [request.method, request.url]), [
      ['post', '/ledger/ious'],
      ['patch', '/ledger/ious/new-iou/paid']
    ]);
    assert.equal(JSON.parse(requests[0].data).amount_cents, 425);
    assert.equal(await store.updateVenmoUsername('roommate-pay'), 'roommate-pay');
    assert.equal(store.venmoUsername, 'roommate-pay');
    assert.deepEqual(requests[2], {
      method: 'patch',
      url: '/ledger/venmo',
      data: JSON.stringify({ venmo_username: 'roommate-pay' })
    });
  } finally {
    restore();
  }
});

test('ledger failures remain visible and reset the loading state', async () => {
  const { store, restore } = await setup(async () => {
    const error = new Error('Ledger request failed');
    error.response = { data: { error: 'Unable to load ledger' } };
    throw error;
  });

  try {
    await assert.rejects(store.fetchLedger(), /Ledger request failed/);
    assert.equal(store.error, 'Unable to load ledger');
    assert.equal(store.loading, false);
  } finally {
    restore();
  }
});

test('reset ignores ledger requests started before the reset', async () => {
  const pendingRequests = [];
  const { store, restore } = await setup(config => new Promise((resolve, reject) => {
    pendingRequests.push({ config, resolve, reject });
  }));

  try {
    const request = store.fetchLedger();
    await new Promise(resolve => setImmediate(resolve));
    store.reset();
    pendingRequests.forEach(({ config, resolve }) => resolve(makeResponse(config, config.url === '/ledger'
      ? {
          transactions: [{ id: 'stale-transaction' }],
          ious: [{ id: 'stale-iou' }],
          members: [{ id: 'stale-member' }],
          venmo_username: 'stale-user'
        }
      : { summary: { netBalance: 1 } })));
    await request;
    assert.deepEqual(store.transactions, []);
    assert.deepEqual(store.ious, []);
    assert.deepEqual(store.members, []);
    assert.equal(store.venmoUsername, '');
    assert.equal(store.summary, null);
    assert.equal(store.loading, false);
    assert.equal(store.error, null);

    const failedRequest = store.fetchLedger();
    await new Promise(resolve => setImmediate(resolve));
    store.reset();
    pendingRequests[2].reject(Object.assign(new Error('stale request failed'), {
      response: { data: { error: 'Stale ledger error' }, status: 500 }
    }));
    pendingRequests[3].resolve(makeResponse(pendingRequests[3].config, { summary: { netBalance: 2 } }));
    await assert.rejects(failedRequest, /stale request failed/);
    assert.deepEqual(store.transactions, []);
    assert.deepEqual(store.ious, []);
    assert.deepEqual(store.members, []);
    assert.equal(store.venmoUsername, '');
    assert.equal(store.summary, null);
    assert.equal(store.loading, false);
    assert.equal(store.error, null);
  } finally {
    restore();
  }
});