import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../utils/api.js';

export const useSupplyStore = defineStore('supplies', () => {
  const supplies = ref([]);
  const members = ref([]);
  const loading = ref(false);
  const error = ref(null);

  async function fetchSupplies() {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.get('/supplies');
      supplies.value = Array.isArray(data?.supplies) ? data.supplies : [];
      members.value = Array.isArray(data?.members) ? data.members : [];
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to load the cleaning supplies list';
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function createSupply(supplyData) {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.post('/supplies', supplyData);
      supplies.value.push(data.supply);
      return data.supply;
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to add cleaning supply';
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function updateSupply(id, changes) {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.patch(`/supplies/${id}`, changes);
      const index = supplies.value.findIndex(supply => supply.id === id);
      if (index !== -1) supplies.value[index] = data.supply;
      return data.supply;
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to update supply';
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function markPurchased(id, actualPriceCents) {
    loading.value = true;
    error.value = null;
    try {
      await api.post(`/supplies/${id}/purchase`, { actual_price_cents: actualPriceCents });
      supplies.value = supplies.value.filter(supply => supply.id !== id);
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to mark supply as purchased';
      throw err;
    } finally {
      loading.value = false;
    }
  }

  return { supplies, members, loading, error, fetchSupplies, createSupply, updateSupply, markPurchased };
});