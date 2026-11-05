const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { compileScript, parse } = require('@vue/compiler-sfc');

global.Document ||= class Document {};
global.ShadowRoot ||= class ShadowRoot {};

const pagePath = path.resolve(__dirname, '../src/pages/LedgerPage.vue');
const { descriptor, errors } = parse(readFileSync(pagePath, 'utf8'), { filename: pagePath });
assert.deepEqual(errors, []);
const compiledPage = compileScript(descriptor, { id: 'ledger-page-test', inlineTemplate: true }).content;

function loadComponent(vue) {
  global.__ledgerPageVue = vue;
  global.__ledgerPageComponent = null;
  const componentSource = compiledPage
    .replace(/import\s+\{([\s\S]*?)\}\s+from\s+['"]vue['"];?/g, (_, bindings) =>
      `const {${bindings.replace(/\s+as\s+/g, ':')}} = global.__ledgerPageVue;`)
    .replace(/import\s+\{\s*useAuthStore\s*\}\s+from\s+['"][^'"]+['"];?/g,
      'const { useAuthStore } = global.__ledgerPageModules;')
    .replace(/import\s+\{\s*useLedgerStore\s*\}\s+from\s+['"][^'"]+['"];?/g,
      'const { useLedgerStore } = global.__ledgerPageModules;')
    .replace(/export default\s+/, 'global.__ledgerPageComponent = ');
  vm.runInThisContext(`{\n${componentSource}\n}`, { filename: pagePath });
  return global.__ledgerPageComponent;
}

function createHost() {
  function detach(node) {
    if (!node.parent) return;
    const siblings = node.parent.children;
    siblings.splice(siblings.indexOf(node), 1);
    node.parent = null;
  }

  return {
    createElement(type) {
      return {
        type,
        props: {},
        children: [],
        parent: null,
        text: '',
        value: '',
        selectedIndex: -1,
        listeners: {},
        addEventListener(event, listener) { this.listeners[event] = listener; },
        removeEventListener() {},
        getRootNode() { return { activeElement: null }; },
        get options() { return this.children.filter(child => child.type === 'option'); }
      };
    },
    createText: text => ({ type: '#text', text: String(text), children: [], parent: null }),
    createComment: text => ({ type: '#comment', text, children: [], parent: null }),
    setText(node, text) { node.text = String(text); },
    setElementText(node, text) { node.text = String(text); node.children = []; },
    patchProp(node, key, _previous, value) {
      node.props[key] = value;
      if (key === 'value') node.value = value;
    },
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

function walkAll(node, predicate, matches = []) {
  if (predicate(node)) matches.push(node);
  for (const child of node.children || []) walkAll(child, predicate, matches);
  return matches;
}

function findButton(root, label) {
  const button = walkAll(root, node => node.type === 'button' && textContent(node).trim() === label)[0];
  assert.ok(button, `Expected button "${label}"`);
  return button;
}

async function mountPage({ fetchFailsOnce = false, createError } = {}) {
  const vue = await import('vue');
  const userId = 'current-user';
  const state = vue.reactive({
    transactions: [{
      id: 'wallet-1', from_user_name: 'Current roommate', to_user_name: 'Other roommate',
      amount_cents: 725, description: 'Wallet settlement', created_at: '2026-01-02T00:00:00Z'
    }],
    ious: [
      { id: 'iou-creditor', debtor_id: 'debtor', debtor_name: 'Debtor', creditor_id: userId, creditor_name: 'Current roommate', amount_cents: 2400, status: 'pending', created_at: '2026-01-03T00:00:00Z' },
      { id: 'iou-debtor', debtor_id: userId, debtor_name: 'Current roommate', creditor_id: 'creditor', creditor_name: 'Creditor', creditor_venmo_username: 'roommate-creditor', amount_cents: 1500, status: 'pending', created_at: '2026-01-04T00:00:00Z' },
      { id: 'iou-paid', debtor_id: userId, debtor_name: 'Current roommate', creditor_id: 'creditor', creditor_name: 'Creditor', amount_cents: 500, status: 'paid', created_at: '2026-01-01T00:00:00Z' }
    ],
    members: [{ id: 'debtor', name: 'Debtor' }, { id: 'creditor', name: 'Creditor' }],
    summary: { owedToMe: 2400, iOweOthers: 1500, netBalance: 900 },
    venmoUsername: '',
    loading: false,
    error: null
  });
  const calls = { fetch: 0, create: [], markPaid: [], venmoUpdates: [] };
  state.fetchLedger = async () => {
    calls.fetch += 1;
    state.loading = true;
    if (fetchFailsOnce && calls.fetch === 1) {
      state.error = 'Ledger API unavailable';
      state.loading = false;
      throw new Error(state.error);
    }
    state.error = null;
    state.loading = false;
  };
  state.createIOU = async payload => {
    calls.create.push(payload);
    if (createError) {
      state.error = createError;
      throw new Error(createError);
    }
    state.ious.unshift({ id: 'new-iou', status: 'pending', ...payload });
  };
  state.markPaid = async id => {
    calls.markPaid.push(id);
    const iou = state.ious.find(item => item.id === id);
    if (iou) iou.status = 'paid';
  };
  state.updateVenmoUsername = async username => {
    calls.venmoUpdates.push(username);
    state.venmoUsername = username.replace(/^@/, '');
    return state.venmoUsername;
  };
  state.formatCents = cents => `$${(Number(cents) / 100).toFixed(2)}`;
  global.__ledgerPageModules = {
    useLedgerStore: () => state,
    useAuthStore: () => ({ user: { id: userId } })
  };

  const renderer = vue.createRenderer(createHost());
  const root = { type: 'root', props: {}, children: [], parent: null };
  renderer.createApp(loadComponent(vue)).mount(root);
  await vue.nextTick();
  await Promise.resolve();
  await vue.nextTick();
  return { root, state, calls, vue };
}

async function input(node, value, vue) {
  node.value = value;
  if (node.props.onInput) node.props.onInput({ target: node });
  else node.listeners.input({ target: node });
  await vue.nextTick();
}

test('shows pending IOUs and wallet transactions separately and only lets the creditor confirm', async () => {
  const { root, calls, vue } = await mountPage();
  const text = textContent(root);

  assert.match(text, /Owed to me/);
  assert.match(text, /\$24\.00/);
  assert.match(text, /Debtor owes Current roommate/);
  assert.match(text, /Current roommate owes Creditor/);
  assert.match(text, /Wallet payment history/);
  assert.match(text, /Wallet settlement/);
  assert.equal(walkAll(root, node => node.type === 'button' && textContent(node).trim() === 'Confirm received').length, 1);

  await findButton(root, 'Confirm received').props.onClick();
  await vue.nextTick();
  assert.deepEqual(calls.markPaid, ['iou-creditor']);
  assert.equal(calls.fetch, 2);
});

test('offers a user-initiated Venmo link and saves the current roommate profile', async () => {
  const { root, state, calls, vue } = await mountPage();
  const payLinks = walkAll(root, node => node.type === 'a' && textContent(node).trim() === 'Open Venmo to pay');
  assert.equal(payLinks.length, 1);
  assert.match(payLinks[0].props.href, /^https:\/\/venmo\.com\/u\/roommate-creditor\?/);
  assert.match(payLinks[0].props.href, /amount=15\.00/);
  assert.match(textContent(root), /Transfers are not verified automatically/);

  const textInputs = walkAll(root, node => node.type === 'input' && node.props.type === 'text');
  await input(textInputs[1], '@current-roommate', vue);
  const forms = walkAll(root, node => node.type === 'form');
  await forms[1].props.onSubmit({ preventDefault() {} });
  await vue.nextTick();
  assert.deepEqual(calls.venmoUpdates, ['@current-roommate']);
  assert.equal(state.venmoUsername, 'current-roommate');
});

test('creates an IOU with the selected direction and converts dollars to integer cents', async () => {
  const { root, calls, vue } = await mountPage();
  const selects = walkAll(root, node => node.type === 'select');
  assert.equal(selects.length, 2);
  selects[0].props['onUpdate:modelValue']('owed');
  selects[1].props['onUpdate:modelValue']('creditor');
  await input(walkAll(root, node => node.type === 'input' && node.props.type === 'number')[0], '12.35', vue);
  await input(walkAll(root, node => node.type === 'input' && node.props.type === 'text')[0], '  Shared cleaning supplies  ', vue);
  const form = walkAll(root, node => node.type === 'form')[0];
  await form.props.onSubmit({ preventDefault() {} });
  await vue.nextTick();

  assert.deepEqual(calls.create, [{
    debtor_id: 'creditor',
    creditor_id: 'current-user',
    amount_cents: 1235,
    description: 'Shared cleaning supplies'
  }]);
});

test('shows ledger load errors and retries without an unhandled rejection', async () => {
  const { root, calls, vue } = await mountPage({ fetchFailsOnce: true });
  assert.match(textContent(root), /Ledger API unavailable/);
  await findButton(root, 'Try again').props.onClick();
  await vue.nextTick();
  assert.equal(calls.fetch, 2);
  assert.doesNotMatch(textContent(root), /Ledger API unavailable/);
});

test('keeps IOU creation failures visible on the page', async () => {
  const { root, calls, vue } = await mountPage({ createError: 'Unable to create IOU' });
  walkAll(root, node => node.type === 'select')[1].props['onUpdate:modelValue']('creditor');
  await input(walkAll(root, node => node.type === 'input' && node.props.type === 'number')[0], '2.00', vue);
  const form = walkAll(root, node => node.type === 'form')[0];
  await form.props.onSubmit({ preventDefault() {} });
  await vue.nextTick();
  assert.equal(calls.create.length, 1);
  assert.match(textContent(root), /Unable to create IOU/);
});