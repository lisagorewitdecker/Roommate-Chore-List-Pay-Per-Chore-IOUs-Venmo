<template>
  <main class="max-w-5xl mx-auto p-6 space-y-6">
    <header class="flex items-center justify-between border-b pb-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 tracking-tight">Roommate Chore Bounty</h1>
        <p class="text-sm text-gray-500">Pick up chores, finish them, and record each household member’s share in the IOU ledger.</p>
      </div>
      <button
        type="button"
        @click="openCreateModal"
        class="bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-lg shadow-sm"
      >
        + Post New Chore
      </button>
    </header>

    <p v-if="actionError" role="alert" class="rounded-lg bg-red-50 p-3 text-sm text-red-700">
      {{ actionError }}
    </p>

    <div v-if="store.loading && !store.chores.length" role="status" class="py-8 text-center text-gray-500">
      Loading chores...
    </div>
    <div v-else-if="loadError" class="rounded-lg bg-red-50 p-4 text-center text-red-700">
      <p role="alert">{{ loadError }}</p>
      <button type="button" @click="loadChores" class="mt-3 underline">Try again</button>
    </div>
    <div v-else-if="!store.chores.length" class="rounded-xl bg-white py-12 text-center text-gray-500">
      No chores yet. Post one to get started!
    </div>

    <div v-else class="grid gap-4 md:grid-cols-2">
      <article
        v-for="chore in store.chores"
        :key="chore.id"
        class="border rounded-xl p-5 bg-white shadow-sm flex flex-col justify-between"
      >
        <div>
          <div class="flex items-start justify-between gap-3">
            <h2 class="font-semibold text-lg text-gray-800">{{ chore.title }}</h2>
            <span class="text-green-600 font-bold text-lg bg-green-50 px-2 py-0.5 rounded">
              ${{ formatPrice(chore.price_cents) }}
            </span>
          </div>
          <p v-if="chore.description" class="text-gray-600 text-sm mt-1">{{ chore.description }}</p>
          <div class="mt-3 flex items-center gap-2">
            <span
              class="text-xs px-2 py-1 rounded-full uppercase font-medium"
              :class="statusClasses(chore.status)"
            >
              {{ statusLabel(chore.status) }}
            </span>
          </div>
        </div>

        <div class="mt-5 border-t pt-3 flex items-center justify-end gap-2">
          <button
            v-if="chore.status === 'open' && !chore.assigned_to?.id && chore.created_by !== authStore.user?.id"
            type="button"
            :disabled="store.loading"
            @click="runChoreAction(() => store.claimChore(chore.id))"
            class="text-xs px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-medium disabled:opacity-50"
          >
            Pick up
          </button>
          <button
            v-if="chore.status === 'open' && chore.assigned_to?.id === authStore.user?.id"
            type="button"
            :disabled="store.loading"
            @click="runChoreAction(() => store.completeChore(chore.id))"
            class="text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded font-medium disabled:opacity-50"
          >
            Mark Complete
          </button>
          <button
            v-if="chore.status === 'completed' && chore.settlement_type !== 'household_iou'"
            type="button"
            :disabled="store.loading"
            @click="runChoreAction(() => store.payChore(chore.id))"
            class="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium shadow-sm disabled:opacity-50"
          >
            Settle &amp; Pay ${{ formatPrice(chore.price_cents) }}
          </button>
          <span v-else-if="chore.status === 'completed'" class="text-xs text-gray-600">
            Household shares recorded in Ledger
          </span>
        </div>
      </article>
    </div>

    <div
      v-if="showCreateModal"
      class="fixed inset-0 bg-black/40 flex items-center justify-center p-4"
      @click.self="closeCreateModal"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-chore-heading"
        class="bg-white rounded-xl max-w-md w-full p-6 space-y-4"
      >
        <h2 id="create-chore-heading" class="text-lg font-bold text-gray-900">Create Chore with AI Bounty</h2>

        <div>
          <label for="chore-title" class="block text-xs font-semibold text-gray-700 uppercase">Chore Title</label>
          <input
            id="chore-title"
            :value="newChore.title"
            @input="newChore.title = $event.target.value"
            type="text"
            required
            placeholder="e.g., Deep clean refrigerator"
            class="w-full border rounded-md p-2 mt-1 focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <label for="chore-description" class="block text-xs font-semibold text-gray-700 uppercase">Description</label>
          <textarea
            id="chore-description"
            :value="newChore.description"
            @input="newChore.description = $event.target.value"
            placeholder="Include messy details..."
            class="w-full border rounded-md p-2 mt-1"
          ></textarea>
        </div>

        <div class="p-3 bg-blue-50 rounded-lg space-y-2">
          <div class="flex justify-between items-center">
            <span class="text-xs font-semibold text-blue-900">AI Valuation</span>
            <button
              type="button"
              @click="runAiPricing"
              :disabled="aiLoading || !newChore.title.trim()"
              class="text-xs text-white bg-blue-600 hover:bg-blue-700 px-2 py-1 rounded disabled:opacity-50"
            >
              {{ aiLoading ? 'Calculating...' : 'Run AI Estimator' }}
            </button>
          </div>
          <p v-if="aiError" role="alert" class="text-xs text-red-700">{{ aiError }}</p>
          <p v-if="aiInsight" class="text-xs text-blue-800 italic">{{ aiInsight }}</p>
        </div>

        <div>
          <label for="chore-reward" class="block text-xs font-semibold text-gray-700 uppercase">Reward Amount ($)</label>
          <input
            id="chore-reward"
            type="number"
            min="0"
            step="0.01"
            :value="(newChore.price_cents / 100).toFixed(2)"
            @input="updateReward"
            class="w-full border rounded-md p-2 mt-1 font-semibold"
          />
        </div>

        <p v-if="createError" role="alert" class="text-sm text-red-700">{{ createError }}</p>
        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            :disabled="creating"
            @click="closeCreateModal"
            class="px-4 py-2 border rounded-md text-sm disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            :disabled="creating || !newChore.title.trim()"
            @click="handleCreate"
            class="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium disabled:opacity-50"
          >
            {{ creating ? 'Posting...' : 'Post Chore' }}
          </button>
        </div>
      </section>
    </div>
  </main>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useChoreStore } from '../stores/choreStore.js';
import { useAuthStore } from '../stores/auth.js';
import api from '../utils/api.js';

const store = useChoreStore();
const authStore = useAuthStore();
const showCreateModal = ref(false);
const aiLoading = ref(false);
const creating = ref(false);
const loadError = ref(null);
const actionError = ref(null);
const aiError = ref(null);
const createError = ref(null);
const aiInsight = ref(null);
const aiRequestId = ref(0);
const newChore = ref({
  title: '',
  description: '',
  price_cents: 500,
  assigned_to: ''
});

onMounted(loadChores);

async function loadChores() {
  loadError.value = null;
  try {
    await store.fetchChores();
  } catch (error) {
    loadError.value = errorMessage(error, 'Failed to load chores');
  }
}

function openCreateModal() {
  actionError.value = null;
  showCreateModal.value = true;
}

function resetForm() {
  aiRequestId.value += 1;
  aiLoading.value = false;
  newChore.value = { title: '', description: '', price_cents: 500, assigned_to: '' };
  aiInsight.value = null;
  aiError.value = null;
  createError.value = null;
}

function closeCreateModal() {
  if (creating.value) return;
  showCreateModal.value = false;
  resetForm();
}

function updateReward(event) {
  const dollars = Number(event.target.value);
  const cents = Math.round((dollars + Number.EPSILON) * 100);
  newChore.value.price_cents = Number.isFinite(dollars) && dollars >= 0 && Number.isSafeInteger(cents)
    ? cents
    : 0;
}

async function runAiPricing() {
  const title = newChore.value.title.trim();
  const description = newChore.value.description;
  if (!title || aiLoading.value) return;

  const requestId = ++aiRequestId.value;
  aiLoading.value = true;
  aiError.value = null;
  aiInsight.value = null;
  try {
    const { data } = await api.post('/ai/estimate-price', { title, description });
    if (requestId !== aiRequestId.value || title !== newChore.value.title.trim() || description !== newChore.value.description) {
      return;
    }
    if (!Number.isSafeInteger(data?.price_cents) || data.price_cents < 0) {
      throw new Error('AI estimator returned an invalid price');
    }
    newChore.value.price_cents = data.price_cents;
    aiInsight.value = `${data.difficulty || 'Estimated'} task${data.reasoning ? `: ${data.reasoning}` : ''}`;
  } catch (error) {
    if (requestId === aiRequestId.value) {
      aiError.value = errorMessage(error, 'Could not estimate a price. Please try again.');
    }
  } finally {
    if (requestId === aiRequestId.value) aiLoading.value = false;
  }
}

async function handleCreate() {
  if (creating.value || !newChore.value.title.trim()) return;
  creating.value = true;
  createError.value = null;
  actionError.value = null;
  try {
    await store.createChore({
      ...newChore.value,
      title: newChore.value.title.trim(),
      description: newChore.value.description.trim()
    });
    showCreateModal.value = false;
    resetForm();
  } catch (error) {
    createError.value = errorMessage(error, 'Failed to create chore');
  } finally {
    creating.value = false;
  }
}

async function runChoreAction(action) {
  actionError.value = null;
  try {
    await action();
  } catch (error) {
    actionError.value = errorMessage(error, 'Could not update this chore');
  }
}

function errorMessage(error, fallback) {
  if (isMissingApiRoute(error)) {
    return 'The API route was not found. The API server may be out of date; restart it from the client directory with npm run dev:api, then try again.';
  }
  return error?.response?.data?.error || error?.message || fallback;
}

function isMissingApiRoute(error) {
  const response = error?.response;
  if (response?.status !== 404) return false;

  const contentType = response.headers?.get?.('content-type')
    || response.headers?.['content-type']
    || response.headers?.['Content-Type'];
  const htmlBody = typeof response.data === 'string' && /^\s*(?:<!doctype\s+html|<html\b)/i.test(response.data);
  return htmlBody || (typeof contentType === 'string' && contentType.toLowerCase().includes('text/html'));
}

function formatPrice(cents) {
  const amount = Number(cents);
  return ((Number.isFinite(amount) ? amount : 0) / 100).toFixed(2);
}

function statusLabel(status) {
  return String(status || 'open').replaceAll('_', ' ');
}

function statusClasses(status) {
  return {
    'bg-yellow-100 text-yellow-800': status === 'open',
    'bg-blue-100 text-blue-800': status === 'completed',
    'bg-emerald-100 text-emerald-800': status === 'verified_paid'
  };
}
</script>