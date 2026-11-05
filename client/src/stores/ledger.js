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
  let sessionVersion = 0;

  function reset() {
    sessionVersion += 1;
    transactions.value = [];
    ious.value = [];
    members.value = [];
    venmoUsername.value = '';
    summary.value = null;
    loading.value = false;
    error.value = null;
  }

  async function fetchLedger() {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      const [ledgerResponse, summaryResponse] = await Promise.all([
        api.get('/ledger'),
        api.get('/ledger/summary')
      ]);
      if (requestSession === sessionVersion) {
        transactions.value = ledgerResponse.data.transactions;
        ious.value = ledgerResponse.data.ious;
        members.value = ledgerResponse.data.members;
        venmoUsername.value = ledgerResponse.data.venmo_username || '';
        summary.value = summaryResponse.data.summary;
      }
    } catch (err) {
      if (requestSession === sessionVersion) {
        error.value = err.response?.data?.error || 'Failed to load the ledger';
      }
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  async function markPaid(id) {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.patch(`/ledger/ious/${id}/paid`);
      const index = ious.value.findIndex(iou => iou.id === id);
      if (requestSession === sessionVersion && index !== -1) ious.value[index] = data.iou;
      return data.iou;
    } catch (err) {
      if (requestSession === sessionVersion) error.value = err.response?.data?.error || 'Failed to confirm the IOU as paid';
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  async function createIOU(iouData) {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.post('/ledger/ious', iouData);
      if (requestSession === sessionVersion) ious.value.unshift(data.iou);
      return data.iou;
    } catch (err) {
      if (requestSession === sessionVersion) error.value = err.response?.data?.error || 'Failed to create IOU';
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  async function updateVenmoUsername(username) {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.patch('/ledger/venmo', { venmo_username: username });
      if (requestSession === sessionVersion) venmoUsername.value = data.venmo_username || '';
      return venmoUsername.value;
    } catch (err) {
      if (requestSession === sessionVersion) error.value = err.response?.data?.error || 'Failed to update Venmo username';
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  function formatCents(cents) {
    const amount = Number(cents);
    return `$${((Number.isFinite(amount) ? amount : 0) / 100).toFixed(2)}`;
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
