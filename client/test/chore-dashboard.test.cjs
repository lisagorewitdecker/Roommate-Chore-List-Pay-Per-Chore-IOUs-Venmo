const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { compileScript, parse } = require('@vue/compiler-sfc');

const dashboardPath = path.resolve(__dirname, '../src/views/ChoreDashboard.vue');
const source = readFileSync(dashboardPath, 'utf8');
const { descriptor, errors } = parse(source, { filename: dashboardPath });
assert.deepEqual(errors, []);
const compiled = compileScript(descriptor, { id: 'chore-dashboard-test', inlineTemplate: true }).content;

function loadComponent(vue) {
  global.__choreDashboardVue = vue;
  global.__choreDashboardComponent = null;
  const componentSource = compiled
    .replace(/import\s+\{([\s\S]*?)\}\s+from\s+['"]vue['"];?/g, (_, bindings) =>
      `const {${bindings.replace(/\s+as\s+/g, ':')}} = global.__choreDashboardVue;`)
    .replace(/import\s+\{\s*useChoreStore\s*\}\s+from\s+['"][^'"]+['"];?/g,
      'const { useChoreStore } = global.__choreDashboardModules;')
    .replace(/import\s+\{\s*useAuthStore\s*\}\s+from\s+['"][^'"]+['"];?/g,
      'const { useAuthStore } = global.__choreDashboardModules;')
    .replace(/import\s+api\s+from\s+['"][^'"]+['"];?/g,
      'const api = global.__choreDashboardModules.api;')
    .replace(/export default\s+/, 'global.__choreDashboardComponent = ');
  vm.runInThisContext(`{\n${componentSource}\n}`, { filename: dashboardPath });
  return global.__choreDashboardComponent;
}

function createHost() {
  function detach(node) {
    if (!node.parent) return;
    const siblings = node.parent.children;
    siblings.splice(siblings.indexOf(node), 1);
    node.parent = null;
  }

  return {
    createElement: type => ({ type, props: {}, children: [], parent: null, text: '' }),
    createText: text => ({ type: '#text', text: String(text), children: [], parent: null }),
    createComment: text => ({ type: '#comment', text, children: [], parent: null }),
    setText(node, text) { node.text = String(text); },
    setElementText(node, text) { node.text = String(text); node.children = []; },
    patchProp(node, key, _previous, value) { node.props[key] = value; },
    insert(node, parent, anchor = null) {
      detach(node);
      node.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(node);
      else parent.children.splice(index, 0, node);
    },
    remove: detach,
    parentNode: node => node.parent,
    nextSibling(node) {
      if (!node.parent) return null;
      return node.parent.children[node.parent.children.indexOf(node) + 1] || null;
    }
  };
}

function textContent(node) {
  return `${node.text || ''}${(node.children || []).map(textContent).join('')}`;
}

function walk(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const result = walk(child, predicate);
    if (result) return result;
  }
  return null;
}

function findButton(root, label) {
  const button = walk(root, node => node.type === 'button' && textContent(node).trim() === label);
  assert.ok(button, `Expected button "${label}"`);
  return button;
}

function findInput(root, id) {
  const input = walk(root, node => node.props?.id === id);
  assert.ok(input, `Expected input "${id}"`);
  return input;
}

async function mountDashboard({ chores = [], fetchError, fetchErrors = [], createError, apiPost } = {}) {
  const vue = await import('vue');
  const state = vue.reactive({ chores, loading: false, error: null });
  const calls = { fetch: 0, create: [], claim: [], complete: [], pay: [] };
  state.fetchChores = async () => {
    calls.fetch += 1;
    if (fetchErrors[calls.fetch - 1]) throw fetchErrors[calls.fetch - 1];
    if (fetchError) throw fetchError;
    state.chores = [...chores];
  };
  state.createChore = async payload => {
    calls.create.push(payload);
    if (createError) throw createError;
    state.chores.unshift({ id: 'new-chore', status: 'open', ...payload });
  };
  state.claimChore = async id => {
    calls.claim.push(id);
    const chore = state.chores.find(item => item.id === id);
    if (chore) chore.assigned_to = { id: 'current-user' };
  };
  state.completeChore = async id => {
    calls.complete.push(id);
    const chore = state.chores.find(item => item.id === id);
    if (chore) chore.status = 'completed';
  };
  state.payChore = async id => calls.pay.push(id);
  global.__choreDashboardModules = {
    useChoreStore: () => state,
    useAuthStore: () => ({ user: { id: 'current-user' } }),
    api: { post: (...args) => apiPost(...args) }
  };

  const renderer = vue.createRenderer(createHost());
  const root = { type: 'root', props: {}, children: [], parent: null };
  renderer.createApp(loadComponent(vue)).mount(root);
  await vue.nextTick();
  await Promise.resolve();
  await vue.nextTick();
  return { root, state, calls, vue };
}

async function click(button, vue) {
  await button.props.onClick();
  await vue.nextTick();
}

function input(inputNode, value, vue) {
  inputNode.props.onInput({ target: { value } });
  return vue.nextTick();
}

test('offers unassigned chores for pickup and completion only to the assigned roommate', async () => {
  const { root, calls, vue } = await mountDashboard({
    chores: [
      { id: 'open', title: 'Vacuum', price_cents: 500, status: 'open', created_by: 'another-user' },
      { id: 'assigned', title: 'Mop', price_cents: 600, status: 'open', assigned_to: { id: 'current-user' } },
      { id: 'other-assigned', title: 'Dust', price_cents: 400, status: 'open', assigned_to: { id: 'another-user' } },
      { id: 'completed', title: 'Dishes', price_cents: 750, status: 'completed' },
      { id: 'paid', title: 'Laundry', price_cents: 1000, status: 'verified_paid' }
    ]
  });

  assert.equal(calls.fetch, 1);
  assert.match(textContent(root), /Roommate Chore Bounty/);
  assert.match(textContent(root), /\$5\.00/);
  assert.ok(findButton(root, 'Pick up'));
  assert.ok(walk(root, node => node.type === 'button' && textContent(node).trim() === 'Mark Complete'));
  assert.ok(walk(root, node => node.type === 'button' && textContent(node).trim() === 'Settle & Pay $7.50'));
  assert.equal(walk(root, node => node.type === 'button' && textContent(node).trim() === 'Settle & Pay $10.00'), null);
  await click(findButton(root, 'Pick up'), vue);
  await click(findButton(root, 'Mark Complete'), vue);
  await click(findButton(root, 'Mark Complete'), vue);
  assert.deepEqual(calls.claim, ['open']);
  assert.deepEqual(calls.complete, ['open', 'assigned']);
  assert.equal(walk(root, node => node.type === 'button' && textContent(node).trim() === 'Mark Complete'), null);
});

test('AI estimate updates the reward and create submits cents then resets the modal', async () => {
  const requests = [];
  const { root, calls, vue } = await mountDashboard({
    apiPost: async (...args) => {
      requests.push(args);
      return { data: { price_cents: 1250, difficulty: 'Medium', reasoning: 'Several steps' } };
    }
  });

  await click(findButton(root, '+ Post New Chore'), vue);
  await input(findInput(root, 'chore-title'), '  Clean fridge  ', vue);
  await input(findInput(root, 'chore-description'), 'Scrub shelves', vue);
  await click(findButton(root, 'Run AI Estimator'), vue);
  assert.deepEqual(requests, [['/ai/estimate-price', { title: 'Clean fridge', description: 'Scrub shelves' }]]);
  assert.equal(findInput(root, 'chore-reward').props.value, '12.50');
  assert.match(textContent(root), /Medium task: Several steps/);
  await input(findInput(root, 'chore-reward'), '13.37', vue);

  await click(findButton(root, 'Post Chore'), vue);
  assert.equal(calls.create.length, 1);
  assert.deepEqual(calls.create[0], {
    title: 'Clean fridge', description: 'Scrub shelves', price_cents: 1337, assigned_to: ''
  });
  assert.equal(walk(root, node => node.props?.role === 'dialog'), null);
  assert.match(textContent(root), /Clean fridge/);
});

test('AI estimator errors are displayed and invalid prices are not applied', async () => {
  let requestCount = 0;
  const { root, vue } = await mountDashboard({
    apiPost: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        throw Object.assign(new Error('AI unavailable'), { response: { data: { error: 'Pricing service unavailable' } } });
      }
      return { data: { price_cents: -1, difficulty: 'Medium', reasoning: 'Invalid price' } };
    }
  });
  await click(findButton(root, '+ Post New Chore'), vue);
  await input(findInput(root, 'chore-title'), 'Clean fridge', vue);
  await click(findButton(root, 'Run AI Estimator'), vue);
  assert.match(textContent(root), /Pricing service unavailable/);
  assert.equal(findInput(root, 'chore-reward').props.value, '5.00');

  await click(findButton(root, 'Run AI Estimator'), vue);
  assert.match(textContent(root), /AI estimator returned an invalid price/);
  assert.equal(findInput(root, 'chore-reward').props.value, '5.00');
});

test('creation failures keep the modal and entered form values available for retry', async () => {
  const { root, calls, vue } = await mountDashboard({
    createError: Object.assign(new Error('Create failed'), { response: { data: { error: 'Chore service unavailable' } } }),
    apiPost: async () => ({ data: {} })
  });
  await click(findButton(root, '+ Post New Chore'), vue);
  await input(findInput(root, 'chore-title'), 'Take out trash', vue);
  await click(findButton(root, 'Post Chore'), vue);

  assert.equal(calls.create.length, 1);
  assert.ok(walk(root, node => node.props?.role === 'dialog'));
  assert.equal(findInput(root, 'chore-title').props.value, 'Take out trash');
  assert.match(textContent(root), /Chore service unavailable/);
});

test('payment and status actions call the store and action failures are shown', async () => {
  const { root, calls, vue } = await mountDashboard({
    chores: [
      { id: 'open', title: 'Vacuum', price_cents: 500, status: 'open', assigned_to: { id: 'current-user' } },
      { id: 'completed', title: 'Dishes', price_cents: 750, status: 'completed' }
    ]
  });

  await click(findButton(root, 'Mark Complete'), vue);
  await click(findButton(root, 'Settle & Pay $7.50'), vue);
  assert.deepEqual(calls.complete, ['open']);
  assert.deepEqual(calls.pay, ['completed']);

  const failed = await mountDashboard({
    chores: [{ id: 'open', title: 'Vacuum', price_cents: 500, status: 'open' }],
    apiPost: async () => ({ data: {} })
  });
  failed.state.chores[0].assigned_to = { id: 'current-user' };
  await failed.vue.nextTick();
  failed.state.completeChore = async () => { throw new Error('Status update rejected'); };
  await click(findButton(failed.root, 'Mark Complete'), failed.vue);
  assert.match(textContent(failed.root), /Status update rejected/);
});

test('fetch failures render a retryable error instead of an unhandled rejection', async () => {
  const { root, calls, vue } = await mountDashboard({ fetchError: new Error('Network unavailable') });
  assert.equal(calls.fetch, 1);
  assert.match(textContent(root), /Network unavailable/);
  assert.ok(findButton(root, 'Try again'));
  await click(findButton(root, 'Try again'), vue);
  assert.equal(calls.fetch, 2);
});

test('HTML 404 from the chore API explains how to restart it and retry', async () => {
  const { root, calls, vue } = await mountDashboard({
    fetchErrors: [Object.assign(new Error('Request failed with status code 404'), {
      response: { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' }, data: '<!DOCTYPE html><html><body>Cannot GET /api/chores</body></html>' }
    })]
  });

  assert.match(textContent(root), /API route was not found/);
  assert.match(textContent(root), /npm run dev:api/);
  await click(findButton(root, 'Try again'), vue);
  assert.equal(calls.fetch, 2);
  assert.match(textContent(root), /No chores yet/);
});

test('JSON 404 errors retain the API-provided message', async () => {
  const { root } = await mountDashboard({
    fetchError: Object.assign(new Error('Request failed with status code 404'), {
      response: { status: 404, headers: { 'content-type': 'application/json' }, data: { error: 'Chore not found' } }
    })
  });

  assert.match(textContent(root), /Chore not found/);
  assert.doesNotMatch(textContent(root), /npm run dev:api/);
});