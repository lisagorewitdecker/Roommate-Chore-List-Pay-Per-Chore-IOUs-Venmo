<!--suppress ALL -->
<template>
  <div class="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-100 to-purple-100">
    <div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md">
      <h1 class="text-2xl font-bold text-center text-gray-800 mb-2">Welcome Back</h1>
      <p class="text-center text-gray-500 mb-6">Sign in to manage your chores</p>

      <form @submit.prevent="handleLogin" class="space-y-4">
        <div>
          <label for="email" class="block text-sm font-medium text-gray-700 mb-1">Email</label>
          <input
            id="email"
            v-model="email"
            type="email"
            required
            class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label for="password" class="block text-sm font-medium text-gray-700 mb-1">Password</label>
          <input
            id="password"
            v-model="password"
            type="password"
            required
            class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            placeholder="••••••••"
          />
        </div>

        <p v-if="authStore.error" class="text-sm text-red-600">{{ authStore.error }}</p>
        <p v-if="passwordResetSuccess" class="text-sm text-green-700" role="status">
          Your password has been reset. Please sign in.
        </p>

        <button
          type="submit"
          :disabled="authStore.loading"
          class="w-full bg-indigo-600 text-white py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition"
        >
          {{ authStore.loading ? 'Signing in...' : 'Sign In' }}
        </button>
      </form>

      <p class="mt-4 text-center text-sm">
        <router-link to="/reset-password" class="text-indigo-600 hover:underline">Forgot your password?</router-link>
      </p>

      <p class="mt-4 text-center text-sm text-gray-600">
        Don't have an account?
        <router-link
            to="/register"
            class="text-indigo-600 hover:underline"
        >
          Register
        </router-link>

      </p>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const authStore = useAuthStore();
const router = useRouter();
const route = useRoute();
const passwordResetSuccess = computed(() => route.query.reset === 'success');
const email = ref('');
const password = ref('');

async function handleLogin() {
  try {
    await authStore.login(email.value, password.value);
    router.push('/');
  } catch (err) {
    // error is stored in authStore
  }
}
</script>
