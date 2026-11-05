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

  async function fetchChores() {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.get('/chores');
      const choreList = Array.isArray(data) ? data : data?.chores;
      chores.value = Array.isArray(choreList) ? choreList : [];
    } catch (err) {
      error.value = choreErrorMessage(err, 'Failed to load chores');
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function createChore(choreData) {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.post('/chores', choreData);
      const chore = unwrapChore(data);
      chores.value.unshift(chore);
      return chore;
    } catch (err) {
      error.value = choreErrorMessage(err, 'Failed to create chore');
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function getChore(id) {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.get(`/chores/${id}`);
      return unwrapChore(data);
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to fetch chore';
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function updateChore(id, choreData) {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.patch(`/chores/${id}`, choreData);
      const chore = unwrapChore(data);
      const index = chores.value.findIndex(c => c.id === id);
      if (index !== -1) {
        chores.value[index] = chore;
      }
      return chore;
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to update chore';
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function updateStatus(id, status) {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.patch(`/chores/${id}`, { status });
      const chore = unwrapChore(data);
      const index = chores.value.findIndex(c => c.id === id);
      if (index !== -1) {
        chores.value[index] = chore;
      }
      return chore;
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to update chore status';
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function completeChore(id) {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.patch(`/chores/${id}/complete`);
      const chore = unwrapChore(data);
      const index = chores.value.findIndex(c => c.id === id);
      if (index !== -1) {
        chores.value[index] = chore;
      }
      return chore;
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to complete chore';
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function claimChore(id) {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.post(`/chores/${id}/claim`);
      const chore = unwrapChore(data);
      const index = chores.value.findIndex(item => item.id === id);
      if (index !== -1) chores.value[index] = chore;
      return chore;
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to pick up chore';
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function offerChore(id) {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.post(`/chores/${id}/offer`);
      const chore = unwrapChore(data);
      const index = chores.value.findIndex(item => item.id === id);
      if (index !== -1) chores.value[index] = chore;
      return chore;
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to offer chore';
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function deleteChore(id) {
    loading.value = true;
    error.value = null;
    try {
      await api.delete(`/chores/${id}`);
      chores.value = chores.value.filter(c => c.id !== id);
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to delete chore';
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function payChore(choreId) {
    loading.value = true;
    error.value = null;
    try {
      await api.post('/payments/pay-chore', { chore_id: choreId });
      await fetchChores();
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to pay chore';
      throw err;
    } finally {
      loading.value = false;
    }
  }

  return {
    chores,
    loading,
    error,
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