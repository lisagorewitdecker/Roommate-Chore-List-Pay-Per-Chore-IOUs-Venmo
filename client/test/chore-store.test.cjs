const assert = require('node:assert/strict');
const test = require('node:test');

function makeResponse(config, data, status = 200) {
  return { data, status, statusText: 'OK', headers: {}, config };
}

async function setup(adapter) {
  const [{ createPinia, setActivePinia }, { default: api }, { useChoreStore }] = await Promise.all([
    import('pinia'),
    import('../src/utils/api.js'),
    import('../src/stores/choreStore.js')
  ]);
  const previousAdapter = api.defaults.adapter;
  const previousLocalStorage = Object.getOwnPropertyDescriptor(global, 'localStorage');
  Object.defineProperty(global, 'localStorage', {
    configurable: true,
    value: { getItem: key => key === 'token' ? 'test-token' : null }
  });
  api.defaults.adapter = adapter;
  setActivePinia(createPinia());

  return {
    api,
    store: useChoreStore(),
    restore() {
      api.defaults.adapter = previousAdapter;
      if (previousLocalStorage === undefined) {
        delete global.localStorage;
      } else {
        Object.defineProperty(global, 'localStorage', previousLocalStorage);
      }
    }
  };
}

test('fetchChores accepts direct and wrapped responses and sends the stored token', async () => {
  const responses = [[{ id: 'direct' }], { chores: [{ id: 'wrapped' }] }];
  const configs = [];
  const { api, store, restore } = await setup(async config => {
    configs.push(config);
    return makeResponse(config, responses.shift());
  });

  try {
    await store.fetchChores();
    assert.deepEqual(store.chores, [{ id: 'direct' }]);
    await store.fetchChores();
    assert.deepEqual(store.chores, [{ id: 'wrapped' }]);
    assert.equal(configs[0].baseURL, '/api');
    assert.equal(configs[0].headers.Authorization, 'Bearer test-token');
    assert.equal(configs[0].url, '/chores');
    assert.equal(api.defaults.adapter instanceof Function, true);
  } finally {
    restore();
  }
});

test('createChore and updateStatus accept direct and wrapped chore responses', async () => {
  const { store, restore } = await setup(async config => {
    if (config.method === 'post') {
      return makeResponse(config, { id: 'created' });
    }
    return makeResponse(config, { chore: { id: 'created', status: 'completed' } });
  });

  try {
    store.chores = [{ id: 'existing', status: 'pending' }];
    const created = await store.createChore({ title: 'New chore' });
    assert.deepEqual(created, { id: 'created' });
    assert.deepEqual(store.chores.map(chore => chore.id), ['created', 'existing']);

    const updated = await store.updateStatus('created', 'completed');
    assert.deepEqual(updated, { id: 'created', status: 'completed' });
    assert.deepEqual(store.chores[0], updated);
  } finally {
    restore();
  }
});

test('HTML 404 responses from chore list and creation explain how to restart the API', async () => {
  const failure = Object.assign(new Error('Request failed with status code 404'), {
    response: {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      data: '<!DOCTYPE html><html><body>Cannot POST /api/chores</body></html>'
    }
  });
  const { store, restore } = await setup(async () => { throw failure; });
  const guidance = /chores API route was not found.*npm run dev:api/;

  try {
    await assert.rejects(store.fetchChores(), /status code 404/);
    assert.match(store.error, guidance);
    await assert.rejects(store.createChore({ title: 'Clean kitchen', price_cents: 2500 }), /status code 404/);
    assert.match(store.error, guidance);
    assert.equal(store.loading, false);
  } finally {
    restore();
  }
});

test('createChore preserves JSON API errors instead of treating them as missing routes', async () => {
  const { store, restore } = await setup(async () => {
    throw Object.assign(new Error('Request failed with status code 404'), {
      response: {
        status: 404,
        headers: { 'content-type': 'application/json' },
        data: { error: 'Chore not found' }
      }
    });
  });

  try {
    await assert.rejects(store.createChore({ title: 'Clean kitchen' }), /status code 404/);
    assert.equal(store.error, 'Chore not found');
  } finally {
    restore();
  }
});

test('fetchChores reports errors, resets loading, and clears stale errors on retry', async () => {
  let rejectRequest;
  const { api, store, restore } = await setup(config => new Promise((resolve, reject) => {
    rejectRequest = reject;
  }));

  try {
    const request = store.fetchChores();
    assert.equal(store.loading, true);
    await new Promise(resolve => setImmediate(resolve));
    const failure = Object.assign(new Error('request failed'), {
      response: { data: { error: 'Chore service unavailable' }, status: 500 }
    });
    rejectRequest(failure);
    await assert.rejects(request, /request failed/);
    assert.equal(store.error, 'Chore service unavailable');
    assert.equal(store.loading, false);

    api.defaults.adapter = async config => makeResponse(config, [{ id: 'recovered' }]);
    await store.fetchChores();
    assert.deepEqual(store.chores, [{ id: 'recovered' }]);
    assert.equal(store.error, null);
    assert.equal(store.loading, false);
  } finally {
    restore();
  }
});

test('payChore posts the server-compatible chore id and refreshes the chore list', async () => {
  const requests = [];
  const { store, restore } = await setup(async config => {
    requests.push(config);
    return makeResponse(config, config.url === '/chores' ? [{ id: 'paid' }] : { success: true });
  });

  try {
    await store.payChore('paid');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, '/payments/pay-chore');
    assert.deepEqual(JSON.parse(requests[0].data), { chore_id: 'paid' });
    assert.equal(requests[1].url, '/chores');
    assert.deepEqual(store.chores, [{ id: 'paid' }]);
    assert.equal(store.loading, false);
  } finally {
    restore();
  }
});

test('payChore records payment errors and does not refresh after failure', async () => {
  let requestCount = 0;
  const { store, restore } = await setup(async config => {
    requestCount += 1;
    throw Object.assign(new Error('payment rejected'), {
      response: { data: { error: 'Payment rejected' }, status: 400 }
    });
  });

  try {
    await assert.rejects(store.payChore('unpaid'), /payment rejected/);
    assert.equal(requestCount, 1);
    assert.equal(store.error, 'Payment rejected');
    assert.equal(store.loading, false);
  } finally {
    restore();
  }
});

test('getChore accepts direct and wrapped responses and requests the requested id', async () => {
  const responses = [{ id: 'direct' }, { chore: { id: 'wrapped' } }];
  const requests = [];
  const { store, restore } = await setup(async config => {
    requests.push(config);
    return makeResponse(config, responses.shift());
  });

  try {
    assert.deepEqual(await store.getChore('direct'), { id: 'direct' });
    assert.deepEqual(await store.getChore('wrapped'), { id: 'wrapped' });
    assert.deepEqual(requests.map(({ method, url }) => [method, url]), [
      ['get', '/chores/direct'],
      ['get', '/chores/wrapped']
    ]);
    assert.equal(store.loading, false);
    assert.equal(store.error, null);
  } finally {
    restore();
  }
});

test('updateChore sends chore data and only replaces an existing chore', async () => {
  const requests = [];
  const { store, restore } = await setup(async config => {
    requests.push(config);
    return makeResponse(config, { chore: { id: 'existing', title: 'Updated chore' } });
  });

  try {
    store.chores = [{ id: 'existing', title: 'Old chore' }];
    const updated = await store.updateChore('existing', { title: 'Updated chore' });
    assert.deepEqual(updated, { id: 'existing', title: 'Updated chore' });
    assert.deepEqual(store.chores, [updated]);
    assert.equal(requests[0].method, 'patch');
    assert.equal(requests[0].url, '/chores/existing');
    assert.deepEqual(JSON.parse(requests[0].data), { title: 'Updated chore' });

    await store.updateChore('not-listed', { title: 'Unlisted chore' });
    assert.deepEqual(store.chores, [updated]);
  } finally {
    restore();
  }
});

test('completeChore sends the completion request and updates the matching chore', async () => {
  let request;
  const { store, restore } = await setup(async config => {
    request = config;
    return makeResponse(config, { id: 'to-complete', status: 'completed' });
  });

  try {
    store.chores = [{ id: 'to-complete', status: 'pending' }];
    const completed = await store.completeChore('to-complete');
    assert.deepEqual(completed, { id: 'to-complete', status: 'completed' });
    assert.deepEqual(store.chores, [completed]);
    assert.equal(request.method, 'patch');
    assert.equal(request.url, '/chores/to-complete/complete');
    assert.equal(request.data, undefined);
    assert.equal(store.loading, false);
  } finally {
    restore();
  }
});

test('deleteChore sends the delete request and removes only the matching chore', async () => {
  let request;
  const { store, restore } = await setup(async config => {
    request = config;
    return makeResponse(config, { success: true });
  });

  try {
    store.chores = [{ id: 'remove' }, { id: 'keep' }];
    await store.deleteChore('remove');
    assert.deepEqual(store.chores, [{ id: 'keep' }]);
    assert.equal(request.method, 'delete');
    assert.equal(request.url, '/chores/remove');
    assert.equal(store.loading, false);
    assert.equal(store.error, null);
  } finally {
    restore();
  }
});

test('chore actions preserve state and expose API errors when requests fail', async () => {
  const actions = [
    ['getChore', store => store.getChore('existing')],
    ['createChore', store => store.createChore({ title: 'New chore' })],
    ['updateChore', store => store.updateChore('existing', { title: 'Changed' })],
    ['updateStatus', store => store.updateStatus('existing', 'completed')],
    ['completeChore', store => store.completeChore('existing')],
    ['deleteChore', store => store.deleteChore('existing')]
  ];

  for (const [actionName, invoke] of actions) {
    const { store, restore } = await setup(async config => {
      throw Object.assign(new Error(`${actionName} rejected`), {
        response: { data: { error: `${actionName} unavailable` }, status: 500 }
      });
    });

    try {
      store.chores = [{ id: 'existing', title: 'Keep unchanged' }];
      await assert.rejects(invoke(store), new RegExp(`${actionName} rejected`));
      assert.deepEqual(store.chores, [{ id: 'existing', title: 'Keep unchanged' }]);
      assert.equal(store.error, `${actionName} unavailable`);
      assert.equal(store.loading, false);
    } finally {
      restore();
    }
  }
});

test('payChore reports refresh failures and preserves the current chore list', async () => {
  const requests = [];
  const { store, restore } = await setup(async config => {
    requests.push(config);
    if (config.url === '/payments/pay-chore') {
      return makeResponse(config, { success: true });
    }
    throw Object.assign(new Error('refresh failed'), {
      response: { data: { error: 'Could not refresh chores' }, status: 500 }
    });
  });

  try {
    store.chores = [{ id: 'unrefreshed' }];
    await assert.rejects(store.payChore('paid'), /refresh failed/);
    assert.deepEqual(requests.map(({ method, url }) => [method, url]), [
      ['post', '/payments/pay-chore'],
      ['get', '/chores']
    ]);
    assert.deepEqual(store.chores, [{ id: 'unrefreshed' }]);
    assert.equal(store.error, 'Could not refresh chores');
    assert.equal(store.loading, false);
  } finally {
    restore();
  }
});