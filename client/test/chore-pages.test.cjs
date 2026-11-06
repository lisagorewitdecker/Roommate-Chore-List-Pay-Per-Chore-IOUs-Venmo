const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { compileScript, parse } = require('@vue/compiler-sfc');

const pages = {
  chores: path.resolve(__dirname, '../src/pages/ChoresPage.vue'),
  ai: path.resolve(__dirname, '../src/pages/AISuggestionsPage.vue')
};
const compiledPages = Object.fromEntries(Object.entries(pages).map(([name, pagePath]) => {
  const source = readFileSync(pagePath, 'utf8');
  const { descriptor, errors } = parse(source, { filename: pagePath });
  assert.deepEqual(errors, []);
  return [name, compileScript(descriptor, { id: `${name}-page-test`, inlineTemplate: true }).content];
}));

function loadComponent(name, vue) {
  const pagePath = pages[name];
  global.__chorePageVue = vue;
  global.__chorePageComponent = null;
  const componentSource = compiledPages[name]
    .replace(/import\s+\{([\s\S]*?)\}\s+from\s+['"]vue['"];?/g, (_, bindings) =>
      `const {${bindings.replace(/\s+as\s+/g, ':')}} = global.__chorePageVue;`)
    .replace(/import\s+api\s+from\s+['"][^'"]+['"];?/g,
      'const api = global.__chorePageModules.api;')
    .replace(/import\s+\{\s*useChoreStore\s*\}\s+from\s+['"][^'"]+['"];?/g,
      'const { useChoreStore } = global.__chorePageModules;')
    .replace(/import\s+\{\s*useAuthStore\s*\}\s+from\s+['"][^'"]+['"];?/g,
      'const { useAuthStore } = global.__chorePageModules;')
    .replace(/export default\s+/, 'global.__chorePageComponent = ');
  vm.runInThisContext(`{\n${componentSource}\n}`, { filename: pagePath });
  return global.__chorePageComponent;
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

function findInput(root, predicate) {
  const input = walk(root, node => ['input', 'textarea'].includes(node.type) && predicate(node));
  assert.ok(input, 'Expected input element');
  return input;
}

async function mountPage(name, { apiPost = async () => ({ data: {} }), createError, fetchError, chores = [] } = {}) {
  const vue = await import('vue');
  const currentUserId = 'test-user';
  const state = vue.reactive({ chores, loading: false, error: null });
  const calls = { fetch: 0, create: [], claim: [], offer: [] };
  state.fetchChores = async () => {
    calls.fetch += 1;
    if (fetchError) {
      state.error = fetchError.response?.data?.error || 'Failed to load chores';
      throw fetchError;
    }
  };
  state.createChore = async payload => {
    calls.create.push(payload);
    if (createError) {
      state.error = createError.response?.data?.error || 'Failed to create chore';
      throw createError;
    }
    state.chores.unshift({ id: 'created-chore', status: 'open', ...payload });
  };
  state.claimChore = async id => {
    calls.claim.push(id);
    const chore = state.chores.find(item => item.id === id);
    if (chore) chore.assigned_to = { id: currentUserId, name: 'Test roommate' };
  };
  state.offerChore = async id => {
    calls.offer.push(id);
    const chore = state.chores.find(item => item.id === id);
    if (chore) chore.assigned_to = null;
  };
  global.__chorePageModules = {
    useChoreStore: () => state,
    useAuthStore: () => ({ user: { id: currentUserId } }),
    api: { post: apiPost }
  };

  const renderer = vue.createRenderer(createHost());
  const root = { type: 'root', props: {}, children: [], parent: null };
  renderer.createApp(loadComponent(name, vue)).mount(root);
  await vue.nextTick();
  await Promise.resolve();
  await vue.nextTick();
  return { root, state, calls, vue };
}

async function click(button, vue) {
  await button.props.onClick();
  await vue.nextTick();
}

async function input(inputNode, value, vue) {
  inputNode.props.onInput({ target: { value } });
  await vue.nextTick();
}

async function setGeminiConsent(root, vue, checked = true) {
  const checkbox = findInput(root, node => node.props.type === 'checkbox');
  checkbox.props.onChange({ target: { checked } });
  await vue.nextTick();
}

test('AI estimate page sends chore details and displays the returned cents estimate', async () => {
  const requests = [];
  const { root, vue } = await mountPage('ai', {
    apiPost: async (...args) => {
      requests.push(args);
      return { data: { price_cents: 1250, difficulty: 'Medium', reasoning: 'Several steps' } };
    }
  });

  await input(findInput(root, node => node.props.id === 'estimate-title'), '  Clean the kitchen  ', vue);
  await input(findInput(root, node => node.props.id === 'estimate-description'), 'Wipe counters', vue);
  const estimateButton = findButton(root, '🤖 Estimate Fair Price');
  assert.equal(estimateButton.props.disabled, true);
  await setGeminiConsent(root, vue);
  assert.equal(estimateButton.props.disabled, false);
  await click(findButton(root, '🤖 Estimate Fair Price'), vue);

  assert.deepEqual(requests, [['/ai/estimate-price', {
    title: 'Clean the kitchen',
    description: 'Wipe counters',
    geminiConsent: true
  }]]);
  assert.match(textContent(root), /\$12\.50/);
  assert.match(textContent(root), /Several steps/);
});

test('fairness page requests and displays the household analysis', async () => {
  const requests = [];
  const { root, vue } = await mountPage('ai', {
    apiPost: async (...args) => {
      requests.push(args);
      return {
        data: {
          analysis: {
            fairness_score: 7,
            observations: ['Roommate 1 has more assigned chores.'],
            recommendations: ['Rotate future assignments.']
          }
        }
      };
    }
  });

  await setGeminiConsent(root, vue);
  await click(findButton(root, '🤖 Analyze Fairness'), vue);

  assert.deepEqual(requests, [['/ai/fair-split', { geminiConsent: true }]]);
  assert.match(textContent(root), /7\/10/);
  assert.match(textContent(root), /Roommate 1 has more assigned chores/);
  assert.match(textContent(root), /Rotate future assignments/);
  assert.match(textContent(root), /recorded chore assignments only/i);
});

test('fairness page clears stale analysis and shows an actionable API error', async () => {
  let requests = 0;
  const { root, vue } = await mountPage('ai', {
    apiPost: async () => {
      requests += 1;
      if (requests === 1) {
        return { data: { analysis: { fairness_score: 8, observations: [], recommendations: [] } } };
      }
      throw Object.assign(new Error('Request failed'), {
        response: { data: { error: 'Assign chores to household members before analyzing fairness.' } }
      });
    }
  });

  await setGeminiConsent(root, vue);
  await click(findButton(root, '🤖 Analyze Fairness'), vue);
  assert.match(textContent(root), /8\/10/);
  await click(findButton(root, '🤖 Analyze Fairness'), vue);

  assert.doesNotMatch(textContent(root), /8\/10/);
  assert.match(textContent(root), /Assign chores to household members before analyzing fairness/);
});

test('AI suggestions page requests and displays chores and adds a suggestion', async () => {
  const requests = [];
  const { root, calls, vue } = await mountPage('ai', {
    apiPost: async (...args) => {
      requests.push(args);
      return {
        data: {
          suggestions: [{
            title: 'Clean shared counters',
            description: 'Wipe kitchen and bathroom counters.',
            suggested_cost_cents: 500,
            frequency: 'Weekly',
            reason: 'Keeps shared surfaces hygienic.'
          }]
        }
      };
    }
  });

  await setGeminiConsent(root, vue);
  await click(findButton(root, '🤖 Get AI Suggestions'), vue);

  assert.deepEqual(requests, [['/ai/suggest-chores', { geminiConsent: true }]]);
  assert.match(textContent(root), /Clean shared counters/);
  assert.match(textContent(root), /Weekly/);
  assert.match(textContent(root), /Suggested frequency is informational/i);
  await click(findButton(root, 'Add Chore'), vue);

  assert.deepEqual(calls.create, [{
    title: 'Clean shared counters',
    description: 'Wipe kitchen and bathroom counters.',
    price_cents: 500
  }]);
  assert.doesNotMatch(textContent(root), /Clean shared counters/);
});

test('AI suggestions page clears stale suggestions and reports add failures', async () => {
  let requests = 0;
  const { root, vue } = await mountPage('ai', {
    createError: Object.assign(new Error('Create failed'), {
      response: { data: { error: 'Unable to create chore right now.' } }
    }),
    apiPost: async () => {
      requests += 1;
      if (requests === 1) {
        return { data: { suggestions: [{ title: 'Wash shared dishes', description: 'Clean dishes.', suggested_cost_cents: 0, frequency: 'Daily', reason: 'Avoid buildup.' }] } };
      }
      throw Object.assign(new Error('Suggestions failed'), {
        response: { data: { error: 'AI suggestions are unavailable; check the server configuration.' } }
      });
    }
  });

  await setGeminiConsent(root, vue);
  await click(findButton(root, '🤖 Get AI Suggestions'), vue);
  await click(findButton(root, 'Add Chore'), vue);
  assert.match(textContent(root), /Unable to create chore right now/);
  assert.match(textContent(root), /Wash shared dishes/);

  await click(findButton(root, '🤖 Get AI Suggestions'), vue);
  assert.doesNotMatch(textContent(root), /Wash shared dishes/);
  assert.match(textContent(root), /AI suggestions are unavailable; check the server configuration/);
});

test('manual chore form submits dollar input as integer price cents', async () => {
  const { root, calls, vue } = await mountPage('chores');

  await click(findButton(root, '+ New Chore'), vue);
  await input(findInput(root, node => node.props.type === 'text'), 'Clean the kitchen', vue);
  await input(findInput(root, node => node.props.type === 'number'), '12.50', vue);
  await input(findInput(root, node => node.type === 'textarea'), 'Wipe counters', vue);
  const form = walk(root, node => node.type === 'form');
  assert.ok(form, 'Expected chore creation form');
  await form.props.onSubmit({ preventDefault() {} });
  await vue.nextTick();

  assert.deepEqual(calls.create, [{
    title: 'Clean the kitchen',
    description: 'Wipe counters',
    price_cents: 1250,
    due_date: null,
    assigned_to: null
  }]);
  assert.match(textContent(root), /\$12\.50/);
  assert.doesNotMatch(textContent(root), /Frequency/);
});

test('manual creation errors stay visible and preserve entered values', async () => {
  const { root, calls, vue } = await mountPage('chores', {
    createError: Object.assign(new Error('Create failed'), { response: { data: { error: 'The chores API route was not found. Restart the API and try again.' } } })
  });
  await click(findButton(root, '+ New Chore'), vue);
  await input(findInput(root, node => node.props.type === 'text'), 'clean kitchen', vue);
  await input(findInput(root, node => node.props.type === 'number'), '25.00', vue);
  await input(findInput(root, node => node.props.type === 'date'), '2026-11-04', vue);
  await input(findInput(root, node => node.type === 'textarea'), 'dsdfadfasdfsdf', vue);
  const form = walk(root, node => node.type === 'form');
  await form.props.onSubmit({ preventDefault() {} });
  await vue.nextTick();

  assert.match(textContent(root), /chores API route was not found/);
  assert.deepEqual(calls.create, [{
    title: 'clean kitchen',
    description: 'dsdfadfasdfsdf',
    price_cents: 2500,
    due_date: '2026-11-04',
    assigned_to: null
  }]);
  assert.equal(findInput(root, node => node.props.type === 'text').props.value, 'clean kitchen');
  assert.equal(findInput(root, node => node.props.type === 'number').props.value, '25.00');
  assert.equal(findInput(root, node => node.props.type === 'date').props.value, '2026-11-04');
  assert.equal(findInput(root, node => node.type === 'textarea').props.value, 'dsdfadfasdfsdf');
  assert.ok(walk(root, node => node.type === 'form'));
});

test('initial chore loading errors are displayed without an unhandled rejection', async () => {
  const { root, calls } = await mountPage('chores', {
    fetchError: Object.assign(new Error('Request failed with status code 404'), {
      response: { data: { error: 'The chores API route was not found. Restart the API and try again.' } }
    })
  });

  assert.equal(calls.fetch, 1);
  assert.match(textContent(root), /chores API route was not found/);
});

test('offered chores can be picked up and a roommate can offer their assigned chore again', async () => {
  const { root, calls, vue } = await mountPage('chores', {
    chores: [
      { id: 'offered-chore', status: 'open', created_by: 'another-user', assigned_to: null },
      { id: 'my-chore', status: 'open', created_by: 'another-user', assigned_to: { id: 'test-user', name: 'Test roommate' } }
    ]
  });

  await click(findButton(root, 'Pick up'), vue);
  assert.deepEqual(calls.claim, ['offered-chore']);
  await click(findButton(root, 'Offer to roommates'), vue);
  assert.deepEqual(calls.offer, ['offered-chore']);
  await click(findButton(root, 'Offer to roommates'), vue);
  assert.deepEqual(calls.offer, ['offered-chore', 'my-chore']);
});