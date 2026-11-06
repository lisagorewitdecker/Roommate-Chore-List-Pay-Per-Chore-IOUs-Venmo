<template>
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div class="flex justify-between items-center mb-6">
      <h1 class="text-2xl font-bold text-gray-800">Chores</h1>
      <button
        @click="showForm = true"
        class="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition"
      >
        + New Chore
      </button>
    </div>

    <p v-if="choreStore.error" role="alert" class="rounded-lg bg-red-50 p-3 text-sm text-red-700 mb-4">
      {{ choreStore.error }}
    </p>

    <!-- New Chore Form -->
    <div v-if="showForm" class="bg-white rounded-xl shadow-md p-6 mb-6">
      <h2 class="text-lg font-semibold mb-4">Create New Chore</h2>
      <form @submit.prevent="handleCreate" class="space-y-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label for="title" class="block text-sm font-medium text-gray-700 mb-1">Title *</label>
            <input
              id="title"
              :value="form.title"
              @input="form.title = $event.target.value"
              type="text"
              required
              class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500"
              placeholder="e.g. Clean Kitchen"
            />
          </div>
          <div>
            <label for="cost" class="block text-sm font-medium text-gray-700 mb-1">Cost ($)</label>
            <input
              id="cost"
              :value="form.costDollars"
              @input="form.costDollars = $event.target.value"
              type="number"
              step="0.01"
              max="21474836.47"
              min="0"
              class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500"
              placeholder="0.00"
            />
          </div>
          <div>
            <label for="due-date" class="block text-sm font-medium text-gray-700 mb-1">Due Date</label>
            <input
              id="due-date"
              :value="form.due_date"
              @input="form.due_date = $event.target.value"
              type="date"
              class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        </div>
        <div>
          <label for="description" class="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <textarea
            id="description"
            :value="form.description"
            @input="form.description = $event.target.value"
            rows="2"
            class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500"
            placeholder="Details about the chore..."
          ></textarea>
        </div>
        <div>
          <label for="assignment" class="block text-sm font-medium text-gray-700 mb-1">Assignment</label>
          <select
            id="assignment"
            :value="form.assigned_to"
            @change="form.assigned_to = $event.target.value"
            class="w-full md:w-1/2 px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">Offer to roommates</option>
            <option v-if="authStore.user?.id" :value="authStore.user.id">Assign to me (offer later)</option>
          </select>
        </div>
        <div class="flex justify-end space-x-2">
          <button
            type="button"
            @click="showForm = false"
            class="px-4 py-2 text-gray-700 border rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            :disabled="choreStore.loading"
            class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            {{ choreStore.loading ? 'Creating...' : 'Create Chore' }}
          </button>
        </div>
      </form>
    </div>

    <!-- Chores List -->
    <div v-if="choreStore.loading && !choreStore.chores.length" class="text-center py-12">
      <div class="text-gray-400">Loading chores...</div>
    </div>

    <div v-else-if="choreStore.chores.length === 0" class="text-center py-12 bg-white rounded-xl">
      <div class="text-4xl mb-4">📋</div>
      <p class="text-gray-500">No chores yet. Create one to get started!</p>
    </div>

    <div v-else class="space-y-4">
      <div
        v-for="chore in choreStore.chores"
        :key="chore.id"
        class="bg-white rounded-xl shadow-md p-6"
        :class="{ 'opacity-60': chore.status !== 'open' }"
      >
        <div class="flex justify-between items-start">
          <div>
            <h3 class="text-lg font-semibold text-gray-800">{{ chore.title }}</h3>
            <p v-if="chore.description" class="text-gray-600 mt-1">{{ chore.description }}</p>
            <div class="flex flex-wrap gap-2 mt-2">
              <span v-if="chore.price_cents > 0" class="px-2 py-1 text-xs bg-green-100 text-green-700 rounded-full">
                ${{ (chore.price_cents / 100).toFixed(2) }}
              </span>
              <span
                :class="{
                  'px-2 py-1 text-xs rounded-full': true,
                  'bg-green-100 text-green-700': chore.status === 'completed' || chore.status === 'verified_paid',
                  'bg-yellow-100 text-yellow-700': chore.status === 'open',
                  'bg-blue-100 text-blue-700': chore.status === 'in_progress'
                }"
              >
                {{ (chore.status || 'open').replaceAll('_', ' ') }}
              </span>
            </div>
            <p v-if="chore.assigned_to?.name" class="text-sm text-gray-500 mt-2">
              Assigned to: {{ chore.assigned_to.name }}
            </p>
            <p v-else-if="chore.status === 'open'" class="text-sm text-indigo-700 mt-2">
              Available for pickup
            </p>
            <p v-if="chore.status === 'completed' && chore.settlement_type === 'household_iou'" class="text-sm text-indigo-700 mt-2">
              Household shares are recorded in the Ledger.
            </p>
          </div>
          <div class="flex flex-wrap justify-end gap-2">
            <button
              v-if="chore.status === 'open' && !chore.assigned_to && chore.created_by !== authStore.user?.id"
              @click="handleClaim(chore.id)"
              :disabled="choreStore.loading"
              class="px-3 py-1 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              Pick up
            </button>
            <button
              v-if="chore.status === 'open' && chore.assigned_to?.id === authStore.user?.id"
              @click="handleOffer(chore.id)"
              :disabled="choreStore.loading"
              class="px-3 py-1 text-sm border border-indigo-600 text-indigo-700 rounded-lg hover:bg-indigo-50 disabled:opacity-50"
            >
              Offer to roommates
            </button>
            <button
              v-if="chore.status === 'open' && chore.assigned_to?.id === authStore.user?.id"
              @click="handleComplete(chore.id)"
              :disabled="choreStore.loading"
              class="px-3 py-1 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700"
            >
              Complete
            </button>
            <button
              v-if="chore.status === 'open' && chore.created_by === authStore.user?.id"
              @click="handleDelete(chore.id)"
              class="px-3 py-1 text-sm text-red-600 border border-red-600 rounded-lg hover:bg-red-50"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useChoreStore } from '../stores/chores';
import { useAuthStore } from '../stores/auth';

const choreStore = useChoreStore();
const authStore = useAuthStore();
const showForm = ref(false);
const form = reactive({
  title: '',
  description: '',
  costDollars: '',
  due_date: '',
  assigned_to: ''
});

onMounted(() => {
  choreStore.fetchChores().catch(() => {});
});

async function handleCreate() {
  const price_cents = form.costDollars === '' ? 0 : Math.round(Number(form.costDollars) * 100);
  if (!Number.isSafeInteger(price_cents) || price_cents < 0 || price_cents > 2147483647) return;
  try {
    await choreStore.createChore({
      title: form.title,
      description: form.description,
      price_cents,
      due_date: form.due_date || null,
      assigned_to: form.assigned_to || null
    });
    form.title = '';
    form.description = '';
    form.costDollars = '';
    form.due_date = '';
    form.assigned_to = '';
    showForm.value = false;
  } catch {
    // Keep the form available so the user can correct the issue or retry.
  }
}

async function handleClaim(id) {
  try {
    await choreStore.claimChore(id);
  } catch {
    // The store exposes the error to the page.
  }
}

async function handleOffer(id) {
  try {
    await choreStore.offerChore(id);
  } catch {
    // The store exposes the error to the page.
  }
}

async function handleComplete(id) {
  try {
    await choreStore.completeChore(id);
  } catch {
    // The store exposes the error to the page.
  }
}

async function handleDelete(id) {
  if (confirm('Are you sure you want to delete this chore?')) {
    try {
      await choreStore.deleteChore(id);
    } catch {
      // The store exposes the error to the page.
    }
  }
}
</script>
