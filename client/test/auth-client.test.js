import assert from 'node:assert/strict';
import { test } from 'node:test';
import api from '../src/utils/api.js';

const responseErrorHandler = api.interceptors.response.handlers[0].rejected;

function setBrowserMocks(removedItems, href) {
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { removeItem: key => removedItems.push(key) }
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { href } }
  });

  return () => {
    if (previousLocalStorage) Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
    else delete globalThis.localStorage;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
  };
}

test('a failed login stays on the login page so its error can be displayed', async () => {
  const removedItems = [];
  const restoreBrowserMocks = setBrowserMocks(removedItems, '/login');

  const error = { response: { status: 401 }, config: { url: '/auth/login' } };
  try {
    await assert.rejects(responseErrorHandler(error), received => received === error);
    assert.deepEqual(removedItems, []);
    assert.equal(globalThis.window.location.href, '/login');
  } finally {
    restoreBrowserMocks();
  }
});

test('other unauthorized API responses clear stored credentials and redirect to login', async () => {
  const removedItems = [];
  const restoreBrowserMocks = setBrowserMocks(removedItems, '/');

  const error = { response: { status: 401 }, config: { url: '/auth/me' } };
  try {
    await assert.rejects(responseErrorHandler(error), received => received === error);
    assert.deepEqual(removedItems, ['token', 'user']);
    assert.equal(globalThis.window.location.href, '/login');
  } finally {
    restoreBrowserMocks();
  }
});

test('invalid or expired tokens clear stored credentials and redirect to login', async () => {
  const removedItems = [];
  const restoreBrowserMocks = setBrowserMocks(removedItems, '/');

  const error = {
    response: { status: 403, data: { error: 'Invalid or expired token' } },
    config: { url: '/auth/me' }
  };
  try {
    await assert.rejects(responseErrorHandler(error), received => received === error);
    assert.deepEqual(removedItems, ['token', 'user']);
    assert.equal(globalThis.window.location.href, '/login');
  } finally {
    restoreBrowserMocks();
  }
});

test('unrelated forbidden responses do not clear credentials or redirect', async () => {
  const removedItems = [];
  const restoreBrowserMocks = setBrowserMocks(removedItems, '/');

  const error = {
    response: { status: 403, data: { error: 'Insufficient permissions' } },
    config: { url: '/payments/pay-chore' }
  };
  try {
    await assert.rejects(responseErrorHandler(error), received => received === error);
    assert.deepEqual(removedItems, []);
    assert.equal(globalThis.window.location.href, '/');
  } finally {
    restoreBrowserMocks();
  }
});