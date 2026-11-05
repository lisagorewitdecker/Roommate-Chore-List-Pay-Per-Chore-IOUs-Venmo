import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../utils/api.js';

function unwrapChore(data) {
  return data?.chore ?? data;
}

function choreErrorMessage(err, fallback) {
  if (isMissingChoreApiRoute(err)) {
    return 'The chores API route was not found. The API server may be out of date; restart it from the client directory with npm run dev:api, then try again.';
  }
  return err.response?.data?.error || fallback;
}

function isMissingChoreApiRoute(err) {
  const response = err?.response;
  if (response?.status !== 404) return false;

  const contentType = response.headers?.get?.('content-type')
    || response.headers?.['content-type']
    || response.headers?.['Content-Type'];
  const htmlBody = typeof response.data === 'string'
    && /^\s*(?:<!doctype\s+html|<html\b)/i.test(response.data);
  return htmlBody || (typeof contentType === 'string' && contentType.toLowerCase().includes('text/html'));
}

export const useChoreStore = defineStore('chores', () => {
  const chores = ref([]);
  const loading = ref(false);
  const error = ref(null);
  let sessionVersion = 0;

  function reset() {
    sessionVersion += 1;
    chores.value = [];
    loading.value = false;
    error.value = null;
  }

  async function fetchChores() {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.get('/chores');
      const choreList = Array.isArray(data) ? data : data?.chores;
      if (requestSession === sessionVersion) {
        chores.value = Array.isArray(choreList) ? choreList : [];
      }
    } catch (err) {
      if (requestSession === sessionVersion) {
        error.value = choreErrorMessage(err, 'Failed to load chores');
      }
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  async function createChore(choreData) {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.post('/chores', choreData);
      const chore = unwrapChore(data);
      if (requestSession === sessionVersion) chores.value.unshift(chore);
      return chore;
    } catch (err) {
      if (requestSession === sessionVersion) error.value = choreErrorMessage(err, 'Failed to create chore');
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  async function getChore(id) {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.get(`/chores/${id}`);
      return unwrapChore(data);
    } catch (err) {
      if (requestSession === sessionVersion) error.value = err.response?.data?.error || 'Failed to fetch chore';
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  async function updateChore(id, choreData) {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.patch(`/chores/${id}`, choreData);
      const chore = unwrapChore(data);
      const index = chores.value.findIndex(c => c.id === id);
      if (requestSession === sessionVersion && index !== -1) {
        chores.value[index] = chore;
      }
      return chore;
    } catch (err) {
      if (requestSession === sessionVersion) error.value = err.response?.data?.error || 'Failed to update chore';
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  async function updateStatus(id, status) {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.patch(`/chores/${id}`, { status });
      const chore = unwrapChore(data);
      const index = chores.value.findIndex(c => c.id === id);
      if (requestSession === sessionVersion && index !== -1) {
        chores.value[index] = chore;
      }
      return chore;
    } catch (err) {
      if (requestSession === sessionVersion) error.value = err.response?.data?.error || 'Failed to update chore status';
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  async function completeChore(id) {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.patch(`/chores/${id}/complete`);
      const chore = unwrapChore(data);
      const index = chores.value.findIndex(c => c.id === id);
      if (requestSession === sessionVersion && index !== -1) {
        chores.value[index] = chore;
      }
      return chore;
    } catch (err) {
      if (requestSession === sessionVersion) error.value = err.response?.data?.error || 'Failed to complete chore';
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  async function claimChore(id) {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.post(`/chores/${id}/claim`);
      const chore = unwrapChore(data);
      const index = chores.value.findIndex(item => item.id === id);
      if (requestSession === sessionVersion && index !== -1) chores.value[index] = chore;
      return chore;
    } catch (err) {
      if (requestSession === sessionVersion) error.value = err.response?.data?.error || 'Failed to pick up chore';
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  async function offerChore(id) {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.post(`/chores/${id}/offer`);
      const chore = unwrapChore(data);
      const index = chores.value.findIndex(item => item.id === id);
      if (requestSession === sessionVersion && index !== -1) chores.value[index] = chore;
      return chore;
    } catch (err) {
      if (requestSession === sessionVersion) error.value = err.response?.data?.error || 'Failed to offer chore';
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  async function deleteChore(id) {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      await api.delete(`/chores/${id}`);
      if (requestSession === sessionVersion) chores.value = chores.value.filter(c => c.id !== id);
    } catch (err) {
      if (requestSession === sessionVersion) error.value = err.response?.data?.error || 'Failed to delete chore';
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  async function payChore(choreId) {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      await api.post('/payments/pay-chore', { chore_id: choreId });
      if (requestSession === sessionVersion) await fetchChores();
    } catch (err) {
      if (requestSession === sessionVersion) error.value = err.response?.data?.error || 'Failed to pay chore';
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  return {
    chores,
    loading,
    error,
    reset,
    fetchChores,
    getChore,
    createChore,
    updateChore,
    updateStatus,
    completeChore,
    deleteChore,
    claimChore,
    offerChore,
    payChore
  };
});