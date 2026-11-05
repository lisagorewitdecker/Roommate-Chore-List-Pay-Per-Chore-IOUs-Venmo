<template>
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
    <div class="flex items-center justify-between gap-4">
      <h1 class="text-2xl font-bold text-gray-800">Ledger & IOUs</h1>
      <button class="text-sm text-indigo-600 hover:underline" :disabled="ledgerStore.loading" @click="retry">
        Refresh
      </button>
    </div>

    <div v-if="ledgerStore.error" role="alert" class="rounded-lg bg-red-50 p-4 text-red-700">
      <p>{{ ledgerStore.error }}</p>
      <button class="mt-2 text-sm font-medium underline" :disabled="ledgerStore.loading" @click="retry">
        Try again
      </button>
    </div>

    <div v-if="ledgerStore.summary" class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div class="bg-white rounded-xl shadow-md p-6">
        <p class="text-sm text-gray-500">Owed to me</p>
        <p class="text-3xl font-bold text-green-600 mt-1">{{ ledgerStore.formatCents(ledgerStore.summary.owedToMe) }}</p>
      </div>
      <div class="bg-white rounded-xl shadow-md p-6">
        <p class="text-sm text-gray-500">I owe others</p>
        <p class="text-3xl font-bold text-red-600 mt-1">{{ ledgerStore.formatCents(ledgerStore.summary.iOweOthers) }}</p>
      </div>
      <div class="bg-white rounded-xl shadow-md p-6">
        <p class="text-sm text-gray-500">Net balance</p>
        <p class="text-3xl font-bold mt-1" :class="ledgerStore.summary.netBalance >= 0 ? 'text-green-600' : 'text-red-600'">
          {{ ledgerStore.formatCents(ledgerStore.summary.netBalance) }}
        </p>
      </div>
    </div>

    <section class="bg-white rounded-xl shadow-md p-6">
      <h2 class="text-lg font-semibold text-gray-800 mb-2">Record an IOU</h2>
      <p class="text-sm text-gray-500 mb-4">This records a debt only; it does not move wallet funds.</p>
      <form class="grid grid-cols-1 md:grid-cols-2 gap-4" @submit.prevent="handleCreateIou">
        <label class="block text-sm font-medium text-gray-700">
          Direction
          <select v-model="form.direction" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm">
            <option value="owe">I owe this roommate</option>
            <option value="owed">This roommate owes me</option>
          </select>
        </label>
        <label class="block text-sm font-medium text-gray-700">
          Roommate
          <select v-model="form.memberId" required class="mt-1 block w-full rounded-md border-gray-300 shadow-sm">
            <option value="" disabled>Select a roommate</option>
            <option v-for="member in ledgerStore.members" :key="member.id" :value="member.id">{{ member.name }}</option>
          </select>
        </label>
        <label class="block text-sm font-medium text-gray-700">
          Amount ($)
          <input v-model="form.amount" type="number" min="0.01" step="0.01" required class="mt-1 block w-full rounded-md border-gray-300 shadow-sm" />
        </label>
        <label class="block text-sm font-medium text-gray-700">
          What is it for?
          <input v-model="form.description" type="text" maxlength="255" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm" />
        </label>
        <div class="md:col-span-2">
          <p v-if="formError" role="alert" class="mb-3 text-sm text-red-600">{{ formError }}</p>
          <button type="submit" :disabled="ledgerStore.loading || !ledgerStore.members.length" class="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white disabled:opacity-50">
            Create IOU
          </button>
          <p v-if="!ledgerStore.members.length && !ledgerStore.loading" class="mt-2 text-sm text-amber-600">
            You're the only member of this household. IOUs require at least two roommates.
            <router-link to="/" class="underline font-medium">Go to the home page</router-link> to copy your invite code and share it with a roommate.
          </p>
        </div>
      </form>
    </section>

    <section class="bg-white rounded-xl shadow-md p-6">
      <h2 class="text-lg font-semibold text-gray-800 mb-2">Venmo payment handoff</h2>
      <p class="text-sm text-gray-500 mb-4">
        Add your username so roommates can open your Venmo profile when paying you. Transfers are not verified automatically.
      </p>
      <form class="flex flex-col sm:flex-row gap-3" @submit.prevent="handleSaveVenmo">
        <label class="flex-1 text-sm font-medium text-gray-700">
          Your Venmo username
          <input
            v-model="venmoUsername"
            type="text"
            maxlength="30"
            autocomplete="off"
            placeholder="username"
            class="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
          />
        </label>
        <button
          type="submit"
          :disabled="ledgerStore.loading"
          class="self-end rounded-md bg-indigo-600 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          Save Venmo username
        </button>
      </form>
    </section>

    <section class="bg-white rounded-xl shadow-md p-6">
      <h2 class="text-lg font-semibold text-gray-800 mb-4">IOUs</h2>
      <p v-if="ledgerStore.loading && !hasLedgerData" class="text-center py-8 text-gray-500">Loading IOUs...</p>
      <p v-else-if="!ledgerStore.ious.length" class="text-center py-8 text-gray-500">No IOUs recorded yet.</p>
      <div v-else class="space-y-3">
        <article v-for="iou in ledgerStore.ious" :key="iou.id" class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border p-4">
          <div>
            <p class="font-medium text-gray-800">{{ iou.debtor_name }} owes {{ iou.creditor_name }}</p>
            <p v-if="iou.description" class="text-sm text-gray-600">{{ iou.description }}</p>
            <p class="text-xs text-gray-400 mt-1">Recorded {{ formatDate(iou.created_at) }}</p>
          </div>
          <div class="sm:text-right">
            <p class="font-bold text-lg" :class="iou.status === 'paid' ? 'text-green-600' : 'text-amber-600'">{{ ledgerStore.formatCents(iou.amount_cents) }}</p>
            <p class="text-xs capitalize text-gray-500">{{ iou.status === 'paid' ? 'Paid — confirmed by creditor' : 'Pending' }}</p>
            <button
              v-if="iou.status === 'pending' && iou.creditor_id === authStore.user?.id"
              class="mt-2 text-sm text-indigo-600 hover:underline disabled:opacity-50"
              :disabled="ledgerStore.loading"
              @click="handleMarkPaid(iou.id)"
            >
              Confirm received
            </button>
            <a
              v-if="iou.status === 'pending' && iou.debtor_id === authStore.user?.id && iou.creditor_venmo_username"
              :href="venmoPayUrl(iou)"
              target="_blank"
              rel="noopener noreferrer"
              class="mt-2 inline-block rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Open Venmo to pay
            </a>
            <p v-if="iou.status === 'pending' && iou.creditor_id === authStore.user?.id" class="mt-2 text-xs text-gray-500">
              You are the creditor; only you can confirm this IOU as paid.
            </p>
            <p v-else-if="iou.status === 'pending' && iou.debtor_id === authStore.user?.id && !iou.creditor_venmo_username" class="mt-2 text-xs text-gray-500">
              {{ iou.creditor_name }} has not added a Venmo username yet.
            </p>
            <p v-else-if="iou.status === 'pending'" class="mt-2 text-xs text-gray-500">
              Only {{ iou.creditor_name }} can confirm payment received.
            </p>
          </div>
        </article>
      </div>
    </section>

    <section class="bg-white rounded-xl shadow-md p-6">
      <h2 class="text-lg font-semibold text-gray-800 mb-4">Wallet payment history</h2>
      <p v-if="!ledgerStore.transactions.length" class="text-center py-8 text-gray-500">No wallet payments yet.</p>
      <div v-else class="space-y-3">
        <article v-for="tx in ledgerStore.transactions" :key="tx.id" class="flex items-center justify-between gap-4 rounded-lg border p-4">
          <div>
            <p class="font-medium text-gray-800">{{ tx.from_user_name }} → {{ tx.to_user_name }}</p>
            <p v-if="tx.description" class="text-sm text-gray-600">{{ tx.description }}</p>
            <p class="text-xs text-gray-400 mt-1">{{ formatDate(tx.created_at) }}</p>
          </div>
          <div class="text-right">
            <p class="font-bold text-green-600">{{ ledgerStore.formatCents(tx.amount_cents) }}</p>
            <p class="text-xs text-gray-500">Wallet transfer</p>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useLedgerStore } from '../stores/ledger';

const ledgerStore = useLedgerStore();
const authStore = useAuthStore();
const form = reactive({ direction: 'owe', memberId: '', amount: '', description: '' });
const formError = ref('');
const venmoUsername = ref('');
const hasLedgerData = computed(() => ledgerStore.transactions.length > 0 || ledgerStore.ious.length > 0);

onMounted(retry);

async function retry() {
  try {
    await ledgerStore.fetchLedger();
    venmoUsername.value = ledgerStore.venmoUsername;
  } catch {
    // The store exposes the API error in the page alert.
  }
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString() : '';
}

function venmoPayUrl(iou) {
  const query = new URLSearchParams({
    txn: 'pay',
    amount: (Number(iou.amount_cents) / 100).toFixed(2),
    note: iou.description || 'Roommate IOU'
  });
  return `https://venmo.com/u/${encodeURIComponent(iou.creditor_venmo_username)}?${query}`;
}

async function handleSaveVenmo() {
  try {
    venmoUsername.value = await ledgerStore.updateVenmoUsername(venmoUsername.value);
  } catch {
    // The store exposes the API error in the page alert.
  }
}

async function handleCreateIou() {
  formError.value = '';
  const amount = Number(form.amount);
  const amountCents = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(amountCents) || amountCents > 2147483647) {
    formError.value = 'Enter a positive amount no greater than $21,474,836.47.';
    return;
  }
  const userId = authStore.user?.id;
  const iou = form.direction === 'owe'
    ? { debtor_id: userId, creditor_id: form.memberId }
    : { debtor_id: form.memberId, creditor_id: userId };
  try {
    await ledgerStore.createIOU({ ...iou, amount_cents: amountCents, description: form.description.trim() });
    form.memberId = '';
    form.amount = '';
    form.description = '';
    await ledgerStore.fetchLedger();
  } catch {
    // The store exposes the API error in the page alert.
  }
}

async function handleMarkPaid(id) {
  try {
    await ledgerStore.markPaid(id);
    await ledgerStore.fetchLedger();
  } catch {
    // The store exposes the API error in the page alert.
  }
}
</script>
