import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import api from '../utils/api.js';
import { useChoreStore } from './choreStore.js';
import { useSupplyStore } from './supplyStore.js';
import { useLedgerStore } from './ledger.js';

export const useAuthStore = defineStore('auth', () => {
  const user = ref(JSON.parse(localStorage.getItem('user') || 'null'));
  const token = ref(localStorage.getItem('token') || null);
  const loading = ref(false);
  const error = ref(null);

  const isAuthenticated = computed(() => !!token.value);

  async function login(email, password) {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.post('/auth/login', { email, password });
      token.value = data.token;
      user.value = data.user;
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      return data;
    } catch (err) {
      error.value = err.response?.data?.error || 'Login failed';
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function register(name, email, password, householdName = '', inviteCode = '') {
    loading.value = true;
    error.value = null;
    try {
      const registration = { name, email, password };
      if (inviteCode.trim()) registration.invite_code = inviteCode.trim();
      else if (householdName.trim()) registration.household_name = householdName.trim();
      const { data } = await api.post('/auth/register', registration);
      token.value = data.token;
      user.value = data.user;
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      return data;
    } catch (err) {
      error.value = err.response?.data?.error || 'Registration failed';
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function fetchMe() {
    try {
      const { data } = await api.get('/auth/me');
      user.value = data.user;
      localStorage.setItem('user', JSON.stringify(data.user));
      return data;
    } catch (err) {
      logout();
      throw err;
    }
  }

  function logout() {
    useChoreStore().reset();
    useSupplyStore().reset();
    useLedgerStore().reset();
    token.value = null;
    user.value = null;
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  }

  return { user, token, loading, error, isAuthenticated, login, register, fetchMe, logout };
});
