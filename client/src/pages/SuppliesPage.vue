<template>
  <main class="supplies-page max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <header class="flex flex-wrap justify-between items-center gap-3 mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-800">Cleaning supplies</h1>
        <p class="text-sm text-gray-600 mt-1">Shared household shopping list</p>
      </div>
      <button
        type="button"
        @click="printList"
        class="print-hidden px-4 py-2 border rounded-lg text-gray-700 hover:bg-gray-50"
      >
        Print list
      </button>
    </header>

    <p v-if="supplyStore.error" role="alert" class="rounded-lg bg-red-50 p-3 text-sm text-red-700 mb-4">
      {{ supplyStore.error }}
    </p>

    <form @submit.prevent="handleCreate" class="print-hidden bg-white rounded-xl shadow-md p-6 mb-6 space-y-4">
      <h2 class="text-lg font-semibold">Add an item</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label class="block text-sm font-medium text-gray-700">
          Item *
          <input
            v-model="form.name"
            required
            maxlength="150"
            class="mt-1 w-full px-3 py-2 border rounded-lg"
            placeholder="Laundry detergent"
          />
        </label>
        <label class="block text-sm font-medium text-gray-700">
          Quantity or notes
          <input
            v-model="form.quantity"
            maxlength="100"
            class="mt-1 w-full px-3 py-2 border rounded-lg"
            placeholder="One large bottle"
          />
        </label>
        <label class="block text-sm font-medium text-gray-700">
          Expected cost ($)
          <input
            v-model="form.costDollars"
            type="number"
            min="0"
            max="21474836.47"
            step="0.01"
            class="mt-1 w-full px-3 py-2 border rounded-lg"
            placeholder="Optional"
          />
        </label>
        <label class="block text-sm font-medium text-gray-700">
          Buyer
          <select v-model="form.assigned_to" class="mt-1 w-full px-3 py-2 border rounded-lg">
            <option value="">Unassigned</option>
            <option v-for="member in supplyStore.members" :key="member.id" :value="member.id">
              {{ member.name }}{{ member.id === authStore.user?.id ? ' (me)' : '' }}
            </option>
          </select>
        </label>
        <label class="block text-sm font-medium text-gray-700">
          Cost responsibility
          <select v-model="form.beneficiary_id" class="mt-1 w-full px-3 py-2 border rounded-lg">
            <option value="">Shared by household</option>
            <option v-for="member in supplyStore.members" :key="member.id" :value="member.id">
              {{ member.name }} only
            </option>
          </select>
        </label>
      </div>
      <div class="flex justify-end">
        <button
          type="submit"
          :disabled="supplyStore.loading"
          class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
        >
          {{ supplyStore.loading ? 'Adding...' : 'Add to list' }}
        </button>
      </div>
    </form>

    <div v-if="supplyStore.loading && !supplyStore.supplies.length" class="text-center py-10 text-gray-500">
      Loading supplies...
    </div>
    <div v-else-if="!supplyStore.supplies.length" class="print-empty bg-white rounded-xl p-8 text-center text-gray-600">
      The list is empty. Add supplies when the household is running low.
    </div>
    <section v-else aria-label="Active cleaning supplies" class="space-y-3">
      <article
        v-for="supply in supplyStore.supplies"
        :key="supply.id"
        class="supply-row bg-white rounded-xl shadow-sm border p-4"
      >
        <div class="flex flex-wrap justify-between gap-4">
          <div class="min-w-0 flex-1">
            <h2 class="text-lg font-semibold text-gray-800">{{ supply.name }}</h2>
            <p v-if="supply.quantity" class="text-sm text-gray-600">{{ supply.quantity }}</p>
            <p v-if="supply.price_cents !== null" class="text-sm text-gray-700 mt-1">
              Expected cost: ${{ (supply.price_cents / 100).toFixed(2) }}
            </p>
            <p class="text-sm text-gray-600 mt-1">
              {{ supply.assigned_member?.id ? `Buyer: ${supply.assigned_member.name}` : 'Buyer: unassigned' }}
            </p>
            <p class="text-sm text-gray-600 mt-1">
              {{ supply.beneficiary?.name ? `For: ${supply.beneficiary.name} only` : 'For the whole household' }}
            </p>
          </div>
          <div class="print-hidden flex flex-wrap items-end gap-2">
            <label class="text-xs text-gray-600">
              Assign buyer
              <select
                :value="supply.assigned_to || ''"
                :disabled="supplyStore.loading"
                @change="handleBuyerChange(supply, $event.target.value)"
                class="block mt-1 px-2 py-2 border rounded-lg text-sm"
              >
                <option value="">Unassigned</option>
                <option v-for="member in supplyStore.members" :key="member.id" :value="member.id">
                  {{ member.name }}
                </option>
              </select>
            </label>
            <label class="text-xs text-gray-600">
              Cost responsibility
              <select
                :value="supply.beneficiary_id || ''"
                :disabled="supplyStore.loading"
                @change="handleBeneficiaryChange(supply, $event.target.value)"
                class="block mt-1 px-2 py-2 border rounded-lg text-sm"
              >
                <option value="">Shared by household</option>
                <option v-for="member in supplyStore.members" :key="member.id" :value="member.id">
                  {{ member.name }} only
                </option>
              </select>
            </label>
            <label class="text-xs text-gray-600">
              Cost ($)
              <input
                :value="supply.price_cents === null ? '' : (supply.price_cents / 100).toFixed(2)"
                type="number"
                min="0"
                max="21474836.47"
                step="0.01"
                :disabled="supplyStore.loading"
                @change="handleCostChange(supply, $event.target.value)"
                class="block mt-1 w-28 px-2 py-2 border rounded-lg text-sm"
              />
            </label>
            <label class="text-xs text-gray-600">
              Actual paid ($)
              <input
                :value="purchaseCosts[supply.id] ?? (supply.price_cents === null ? '' : (supply.price_cents / 100).toFixed(2))"
                type="number"
                min="0"
                max="21474836.47"
                step="0.01"
                :disabled="supplyStore.loading"
                @input="purchaseCosts[supply.id] = $event.target.value"
                class="block mt-1 w-28 px-2 py-2 border rounded-lg text-sm"
              />
            </label>
            <button
              v-if="!supply.assigned_to || supply.assigned_to === authStore.user?.id"
              type="button"
              :disabled="supplyStore.loading"
              @click="handlePurchase(supply)"
              class="px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              Bought it
            </button>
            <span v-else class="text-xs text-gray-500">Assigned buyer marks as purchased</span>
          </div>
        </div>
      </article>
    </section>
    <p class="print-note hidden print:block mt-6 text-sm text-gray-600">
      Purchases create household IOUs for the actual cost. They do not automatically transfer money.
    </p>
  </main>
</template>

<script setup>
import { onMounted, reactive } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useSupplyStore } from '../stores/supplyStore';

const authStore = useAuthStore();
const supplyStore = useSupplyStore();
const form = reactive({ name: '', quantity: '', costDollars: '', assigned_to: '', beneficiary_id: '' });
const purchaseCosts = reactive({});

onMounted(() => {
  supplyStore.fetchSupplies().catch(() => {});
});

function parseCost(value) {
  if (value === '') return null;
  const dollars = Number(value);
  const cents = Math.round(dollars * 100);
  if (!Number.isFinite(dollars) || dollars < 0 || !Number.isSafeInteger(cents) || cents > 2147483647) {
    throw new Error('Enter a valid non-negative cost.');
  }
  return cents;
}

async function handleCreate() {
  try {
    await supplyStore.createSupply({
      name: form.name,
      quantity: form.quantity,
      price_cents: parseCost(form.costDollars),
      assigned_to: form.assigned_to || null,
      beneficiary_id: form.beneficiary_id || null
    });
    form.name = '';
    form.quantity = '';
    form.costDollars = '';
    form.assigned_to = '';
    form.beneficiary_id = '';
  } catch (error) {
    if (error.message && !error.response) supplyStore.error = error.message;
  }
}

async function handleBuyerChange(supply, assignedTo) {
  try {
    await supplyStore.updateSupply(supply.id, { assigned_to: assignedTo || null });
  } catch {
    // The store exposes the error to the page.
  }
}

async function handleBeneficiaryChange(supply, beneficiaryId) {
  try {
    await supplyStore.updateSupply(supply.id, { beneficiary_id: beneficiaryId || null });
  } catch {
    // The store exposes the error to the page.
  }
}

async function handleCostChange(supply, value) {
  try {
    await supplyStore.updateSupply(supply.id, { price_cents: parseCost(value) });
  } catch (error) {
    if (error.message && !error.response) supplyStore.error = error.message;
  }
}

async function handlePurchase(supply) {
  let actualPriceCents;
  try {
    const enteredCost = purchaseCosts[supply.id]
      ?? (supply.price_cents === null ? '' : (supply.price_cents / 100).toFixed(2));
    actualPriceCents = parseCost(enteredCost);
    if (actualPriceCents === null) throw new Error('Enter the actual purchase cost before marking this item purchased.');
  } catch (error) {
    supplyStore.error = error.message;
    return;
  }
  try {
    await supplyStore.markPurchased(supply.id, actualPriceCents);
  } catch {
    // The store exposes the error to the page.
  }
}

function printList() {
  window.print();
}
</script>

<style scoped>
@media print {
  .supplies-page {
    max-width: none;
    padding: 0;
  }

  .print-hidden,
  :global(nav) {
    display: none !important;
  }

  .supply-row {
    break-inside: avoid;
    box-shadow: none;
  }

  .print-empty {
    border: 1px solid #d1d5db;
  }
}
</style>