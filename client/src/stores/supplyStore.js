import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../utils/api.js';

export const useSupplyStore = defineStore('supplies', () => {
  const supplies = ref([]);
  const members = ref([]);
  const loading = ref(false);
  const error = ref(null);
  let sessionVersion = 0;

  function reset() {
    sessionVersion += 1;
    supplies.value = [];
    members.value = [];
    loading.value = false;
    error.value = null;
  }

  async function fetchSupplies() {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.get('/supplies');
      if (requestSession === sessionVersion) {
        supplies.value = Array.isArray(data?.supplies) ? data.supplies : [];
        members.value = Array.isArray(data?.members) ? data.members : [];
      }
    } catch (err) {
      if (requestSession === sessionVersion) {
        error.value = err.response?.data?.error || 'Failed to load the cleaning supplies list';
      }
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  async function createSupply(supplyData) {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.post('/supplies', supplyData);
      if (requestSession === sessionVersion) supplies.value.push(data.supply);
      return data.supply;
    } catch (err) {
      if (requestSession === sessionVersion) error.value = err.response?.data?.error || 'Failed to add cleaning supply';
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  async function updateSupply(id, changes) {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.patch(`/supplies/${id}`, changes);
      const index = supplies.value.findIndex(supply => supply.id === id);
      if (requestSession === sessionVersion && index !== -1) supplies.value[index] = data.supply;
      return data.supply;
    } catch (err) {
      if (requestSession === sessionVersion) error.value = err.response?.data?.error || 'Failed to update supply';
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  async function markPurchased(id, actualPriceCents) {
    const requestSession = sessionVersion;
    loading.value = true;
    error.value = null;
    try {
      await api.post(`/supplies/${id}/purchase`, { actual_price_cents: actualPriceCents });
      if (requestSession === sessionVersion) {
        supplies.value = supplies.value.filter(supply => supply.id !== id);
      }
    } catch (err) {
      if (requestSession === sessionVersion) {
        error.value = err.response?.data?.error || 'Failed to mark supply as purchased';
      }
      throw err;
    } finally {
      if (requestSession === sessionVersion) loading.value = false;
    }
  }

  return { supplies, members, loading, error, reset, fetchSupplies, createSupply, updateSupply, markPurchased };
});