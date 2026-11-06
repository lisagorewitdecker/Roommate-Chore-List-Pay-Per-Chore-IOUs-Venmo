import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../utils/api.js';

export const useLedgerStore = defineStore('ledger', () => {
  const transactions = ref([]);
  const ious = ref([]);
  const members = ref([]);
  const venmoUsername = ref('');
  const summary = ref(null);
  const loading = ref(false);
  const error = ref(null);
  let session = 0;

  function isCurrentSession(requestSession) {
    return requestSession === session;
  }

  function reset() {
    session += 1;
    transactions.value = [];
    ious.value = [];
    members.value = [];
    venmoUsername.value = '';
    summary.value = null;
    loading.value = false;
    error.value = null;
  }

  async function fetchLedger() {
    const requestSession = session;
    loading.value = true;
    error.value = null;
    try {
      const [ledgerResponse, summaryResponse] = await Promise.all([
        api.get('/ledger'),
        api.get('/ledger/summary')
      ]);
      if (isCurrentSession(requestSession)) {
        transactions.value = ledgerResponse.data.transactions;
        ious.value = ledgerResponse.data.ious;
        members.value = ledgerResponse.data.members;
        venmoUsername.value = ledgerResponse.data.venmo_username || '';
        summary.value = summaryResponse.data.summary;
      }
    } catch (err) {
      if (isCurrentSession(requestSession)) {
        error.value = err.response?.data?.error || 'Failed to load the ledger';
      }
      throw err;
    } finally {
      if (isCurrentSession(requestSession)) loading.value = false;
    }
  }

  async function markPaid(id) {
    const requestSession = session;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.patch(`/ledger/ious/${id}/paid`);
      const index = ious.value.findIndex(iou => iou.id === id);
      if (isCurrentSession(requestSession) && index !== -1) ious.value[index] = data.iou;
      return data.iou;
    } catch (err) {
      if (isCurrentSession(requestSession)) {
        error.value = err.response?.data?.error || 'Failed to confirm the IOU as paid';
      }
      throw err;
    } finally {
      if (isCurrentSession(requestSession)) loading.value = false;
    }
  }

  async function createIOU(iouData) {
    const requestSession = session;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.post('/ledger/ious', iouData);
      if (isCurrentSession(requestSession)) ious.value.unshift(data.iou);
      return data.iou;
    } catch (err) {
      if (isCurrentSession(requestSession)) {
        error.value = err.response?.data?.error || 'Failed to create IOU';
      }
      throw err;
    } finally {
      if (isCurrentSession(requestSession)) loading.value = false;
    }
  }

  async function updateVenmoUsername(username) {
    const requestSession = session;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.patch('/ledger/venmo', { venmo_username: username });
      if (isCurrentSession(requestSession)) {
        venmoUsername.value = data.venmo_username || '';
      }
      return venmoUsername.value;
    } catch (err) {
      if (isCurrentSession(requestSession)) {
        error.value = err.response?.data?.error || 'Failed to update Venmo username';
      }
      throw err;
    } finally {
      if (isCurrentSession(requestSession)) loading.value = false;
    }
  }

  function formatCents(cents) {
    const amount = Number(cents);
    return `$${((Number.isFinite(amount) ? amount : 0) / 100).toFixed(2)}`;
  }

  function reset() {
    transactions.value = [];
    ious.value = [];
    members.value = [];
    venmoUsername.value = '';
    summary.value = null;
    loading.value = false;
    error.value = null;
  }

  return {
    transactions,
    ious,
    members,
    venmoUsername,
    summary,
    loading,
    error,
    reset,
    fetchLedger,
    markPaid,
    createIOU,
    updateVenmoUsername,
    formatCents
  };
});
