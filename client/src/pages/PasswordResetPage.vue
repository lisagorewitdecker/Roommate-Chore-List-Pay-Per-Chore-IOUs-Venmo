<template>
  <div class="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-100 to-purple-100">
    <div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md">
      <h1 class="text-2xl font-bold text-center text-gray-800 mb-2">
        {{ resetToken ? 'Choose a new password' : 'Reset your password' }}
      </h1>
      <p class="text-center text-gray-500 mb-6">
        {{ resetToken ? 'Enter a new password for your account' : 'We will email you a secure password reset link' }}
      </p>

      <form v-if="resetToken && !completed" @submit.prevent="handleComplete" class="space-y-4">
        <div>
          <label for="new-password" class="block text-sm font-medium text-gray-700 mb-1">New password</label>
          <input
            id="new-password"
            v-model="password"
            type="password"
            required
            minlength="8"
            autocomplete="new-password"
            class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            placeholder="At least 8 characters"
          />
        </div>
        <div>
          <label for="confirm-password" class="block text-sm font-medium text-gray-700 mb-1">Confirm new password</label>
          <input
            id="confirm-password"
            v-model="confirmPassword"
            type="password"
            required
            minlength="8"
            autocomplete="new-password"
            class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            placeholder="Enter the password again"
          />
        </div>
        <p v-if="error" class="text-sm text-red-600" role="alert">{{ error }}</p>
        <button
          type="submit"
          :disabled="loading"
          class="w-full bg-indigo-600 text-white py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition"
        >
          {{ loading ? 'Updating password...' : 'Update Password' }}
        </button>
      </form>

      <form v-else-if="!resetToken" @submit.prevent="handleRequest" class="space-y-4">
        <div>
          <label for="email" class="block text-sm font-medium text-gray-700 mb-1">Email</label>
          <input
            id="email"
            v-model="email"
            type="email"
            required
            autocomplete="email"
            class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            placeholder="you@example.com"
          />
        </div>
        <p v-if="error" class="text-sm text-red-600" role="alert">{{ error }}</p>
        <p v-if="successMessage" class="text-sm text-green-700" role="status">{{ successMessage }}</p>
        <button
          type="submit"
          :disabled="loading"
          class="w-full bg-indigo-600 text-white py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition"
        >
          {{ loading ? 'Sending link...' : 'Send Reset Link' }}
        </button>
      </form>

      <p v-if="completed" class="text-sm text-green-700 text-center" role="status">
        Your password has been updated. You can now sign in.
      </p>
      <p class="mt-4 text-center text-sm text-gray-600">
        <router-link to="/login" class="text-indigo-600 hover:underline">Back to sign in</router-link>
      </p>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import api from '../utils/api';

const route = useRoute();
const router = useRouter();
const resetToken = computed(() => typeof route.query.token === 'string' ? route.query.token : '');
const email = ref('');
const password = ref('');
const confirmPassword = ref('');
const loading = ref(false);
const error = ref('');
const successMessage = ref('');
const completed = ref(false);

async function handleRequest() {
  loading.value = true;
  error.value = '';
  successMessage.value = '';
  try {
    const { data } = await api.post('/auth/password-reset/request', { email: email.value });
    successMessage.value = data.message;
  } catch (err) {
    error.value = err.response?.data?.error || 'Unable to send a password reset link';
  } finally {
    loading.value = false;
  }
}

async function handleComplete() {
  error.value = '';
  if (password.value !== confirmPassword.value) {
    error.value = 'Passwords do not match';
    return;
  }

  loading.value = true;
  try {
    await api.post('/auth/password-reset/complete', { token: resetToken.value, password: password.value });
    completed.value = true;
    password.value = '';
    confirmPassword.value = '';
    await router.replace({ name: 'Login', query: { reset: 'success' } });
  } catch (err) {
    error.value = err.response?.data?.error || 'Unable to reset your password';
  } finally {
    loading.value = false;
  }
}
</script>