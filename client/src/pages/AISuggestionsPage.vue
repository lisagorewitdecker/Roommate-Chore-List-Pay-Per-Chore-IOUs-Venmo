<template>
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <h1 class="text-2xl font-bold text-gray-800 mb-6">AI Chore Suggestions</h1>

    <div class="bg-white rounded-xl shadow-md p-6 mb-8">
      <p class="text-gray-600 mb-4">
        Get AI-powered suggestions for new chores based on your current household setup.
        The AI analyzes your existing chores and roommates to recommend fair and practical tasks.
      </p>
      <p class="text-sm text-gray-500 mb-4">
        Gemini is a third-party service. AI suggestions send existing chore titles and anonymous assignment counts;
        price estimates send the chore title and description; fairness analysis sends anonymous chore counts and values.
        Chore titles and descriptions may contain personal information. Nothing is sent until you agree below.
        Suggested frequency is informational and is not saved as a recurring schedule.
      </p>
      <label class="flex items-start gap-2 text-sm text-gray-700 mb-4">
        <input
          type="checkbox"
          :checked="geminiConsent"
          @change="geminiConsent = $event.target.checked"
          class="mt-1"
        />
        <span>I agree to send the described chore data to Gemini for these AI features. Uncheck this any time to opt out.</span>
      </label>
      <button
        @click="handleSuggest"
        :disabled="!geminiConsent || loading || addingSuggestion !== null"
        class="bg-indigo-600 text-white px-6 py-3 rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition"
      >
        {{ loading ? '🤖 Thinking...' : '🤖 Get AI Suggestions' }}
      </button>
      <p v-if="error" role="alert" class="text-sm text-red-600 mt-3">{{ error }}</p>
    </div>

    <!-- AI Price Estimate -->
    <div class="bg-white rounded-xl shadow-md p-6 mb-8">
      <h2 class="text-lg font-semibold text-gray-800 mb-4">AI Price Estimate</h2>
      <p class="text-gray-600 mb-4">
        Describe a chore to get an AI-generated estimate. You can still set a price manually when creating a chore.
      </p>
      <div class="space-y-3 mb-4">
        <div>
          <label for="estimate-title" class="block text-sm font-medium text-gray-700 mb-1">Chore title</label>
          <input
            id="estimate-title"
            :value="estimateForm.title"
            @input="estimateForm.title = $event.target.value"
            type="text"
            maxlength="150"
            required
            class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-teal-500"
            placeholder="e.g. Deep clean the kitchen"
          />
        </div>
        <div>
          <label for="estimate-description" class="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <textarea
            id="estimate-description"
            :value="estimateForm.description"
            @input="estimateForm.description = $event.target.value"
            maxlength="2000"
            rows="2"
            class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-teal-500"
            placeholder="Add details about the effort involved"
          ></textarea>
        </div>
      </div>
      <button
        @click="onEstimatePrice"
        :disabled="!geminiConsent || estimateLoading || !estimateForm.title.trim()"
        class="bg-teal-600 text-white px-6 py-3 rounded-lg hover:bg-teal-700 disabled:opacity-50 transition"
      >
        {{ estimateLoading ? '🤖 Estimating...' : '🤖 Estimate Fair Price' }}
      </button>
      <p v-if="estimateError" role="alert" class="text-sm text-red-600 mt-3">{{ estimateError }}</p>

      <div v-if="estimatedPrice" class="mt-6 p-4 bg-teal-50 rounded-lg">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="font-medium text-gray-700">Estimated Fair Price</h3>
            <p class="text-3xl font-bold text-teal-600 mt-1">
              {{ formatCentsForDisplay(estimatedPrice.price_cents) }}
            </p>
            <p v-if="estimatedPrice.reasoning" class="text-sm text-gray-600 mt-2 italic">
              💡 {{ estimatedPrice.reasoning }}
            </p>
          </div>
          <div v-if="estimatedPrice.range" class="text-right">
            <p class="text-sm text-gray-500">Price Range</p>
            <p class="text-lg font-semibold text-gray-700">
              {{ formatCentsForDisplay(estimatedPrice.range.min) }} - {{ formatCentsForDisplay(estimatedPrice.range.max) }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- Fairness Analysis -->
    <div class="bg-white rounded-xl shadow-md p-6 mb-8">
      <h2 class="text-lg font-semibold text-gray-800 mb-4">Fairness Analysis</h2>
      <p class="text-gray-600 mb-4">
        This analysis reflects recorded chore assignments only; it is a snapshot, not a definitive judgment of fairness.
      </p>
      <button
        @click="handleFairSplit"
        :disabled="!geminiConsent || fairLoading"
        class="bg-purple-600 text-white px-6 py-3 rounded-lg hover:bg-purple-700 disabled:opacity-50 transition"
      >
        {{ fairLoading ? '🤖 Analyzing...' : '🤖 Analyze Fairness' }}
      </button>
      <p v-if="fairError" class="text-sm text-red-600 mt-3">{{ fairError }}</p>

      <div v-if="fairnessAnalysis" class="mt-6 space-y-4">
        <div class="flex items-center space-x-4">
          <span class="text-sm text-gray-500">Fairness Score:</span>
          <div class="flex-1 bg-gray-200 rounded-full h-4">
            <div
              class="bg-indigo-600 h-4 rounded-full transition-all"
              :style="{ width: `${(fairnessAnalysis.fairness_score || 0) * 10}%` }"
            ></div>
          </div>
          <span class="font-bold text-indigo-600">{{ fairnessAnalysis.fairness_score }}/10</span>
        </div>

        <div v-if="fairnessAnalysis.observations?.length">
          <h3 class="font-medium text-gray-700 mb-2">Observations:</h3>
          <ul class="space-y-1">
            <li
              v-for="(obs, i) in fairnessAnalysis.observations"
              :key="i"
              class="text-sm text-gray-600 flex items-start"
            >
              <span class="mr-2">•</span> {{ obs }}
            </li>
          </ul>
        </div>

        <div v-if="fairnessAnalysis.recommendations?.length">
          <h3 class="font-medium text-gray-700 mb-2">Recommendations:</h3>
          <ul class="space-y-1">
            <li
              v-for="(rec, i) in fairnessAnalysis.recommendations"
              :key="i"
              class="text-sm text-gray-600 flex items-start"
            >
              <span class="mr-2">→</span> {{ rec }}
            </li>
          </ul>
        </div>
      </div>
    </div>

    <!-- Suggestions -->
    <div v-if="suggestions.length" class="space-y-4">
      <h2 class="text-lg font-semibold text-gray-800">Suggestions</h2>
      <div
        v-for="(suggestion, index) in suggestions"
        :key="index"
        class="bg-white rounded-xl shadow-md p-6"
      >
        <div class="flex justify-between items-start">
          <div>
            <h3 class="text-lg font-semibold text-gray-800">{{ suggestion.title }}</h3>
            <p class="text-gray-600 mt-1">{{ suggestion.description }}</p>
            <div class="flex flex-wrap gap-2 mt-2">
              <span class="px-2 py-1 text-xs bg-indigo-100 text-indigo-700 rounded-full">
                {{ suggestion.frequency }}
              </span>
              <span
                v-if="suggestion.suggested_cost_cents != null"
                class="px-2 py-1 text-xs bg-green-100 text-green-700 rounded-full"
              >
                ${{ (suggestion.suggested_cost_cents / 100).toFixed(2) }}
              </span>
            </div>
            <p class="text-sm text-gray-500 mt-2 italic">
              💡 {{ suggestion.reason }}
            </p>
          </div>
          <button
            @click="handleAddSuggestion(suggestion)"
            :disabled="addingSuggestion !== null"
            class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm"
          >
            {{ addingSuggestion === suggestion ? 'Adding...' : 'Add Chore' }}
          </button>
        </div>
      </div>
      <p v-if="suggestionAddError" role="alert" class="text-sm text-red-600">{{ suggestionAddError }}</p>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import api from '../utils/api';
import { useChoreStore } from '../stores/chores';

const choreStore = useChoreStore();
const geminiConsent = ref(false);
const suggestions = ref([]);
const loading = ref(false);
const error = ref(null);
const addingSuggestion = ref(null);
const suggestionAddError = ref(null);
const fairLoading = ref(false);
const fairError = ref(null);
const fairnessAnalysis = ref(null);
const estimatedPrice = ref(null);
const estimateLoading = ref(false);
const estimateError = ref(null);
const estimateForm = ref({ title: '', description: '' });

async function handleSuggest() {
  loading.value = true;
  error.value = null;
  suggestions.value = [];
  suggestionAddError.value = null;
  try {
    const { data } = await api.post('/ai/suggest-chores', { geminiConsent: geminiConsent.value });
    if (!Array.isArray(data?.suggestions)) {
      throw new Error('AI returned an invalid suggestion list. Please try again.');
    }
    suggestions.value = data.suggestions;
  } catch (err) {
    error.value = err.response?.data?.error || err.message || 'Failed to get suggestions';
  } finally {
    loading.value = false;
  }
}

async function handleFairSplit() {
  fairLoading.value = true;
  fairError.value = null;
  fairnessAnalysis.value = null;
  try {
    const { data } = await api.post('/ai/fair-split', { geminiConsent: geminiConsent.value });
    fairnessAnalysis.value = data.analysis;
  } catch (err) {
    fairError.value = err.response?.data?.error || 'Failed to analyze fairness';
  } finally {
    fairLoading.value = false;
  }
}

async function handleEstimatePrice() {
  estimateLoading.value = true;
  estimateError.value = null;
  estimatedPrice.value = null;
  try {
    const { data } = await api.post('/ai/estimate-price', {
      title: estimateForm.value.title.trim(),
      description: estimateForm.value.description.trim(),
      geminiConsent: geminiConsent.value
    });
    if (!Number.isSafeInteger(data?.price_cents) || data.price_cents < 1) {
      throw new Error('The estimator returned an invalid price. Please try again.');
    }
    return data;
  } catch (err) {
    estimateError.value = err.response?.data?.error || err.message || 'Failed to estimate price';
  } finally {
    estimateLoading.value = false;
  }
}

async function handleAddSuggestion(suggestion) {
  addingSuggestion.value = suggestion;
  suggestionAddError.value = null;
  try {
    await choreStore.createChore({
      title: suggestion.title,
      description: suggestion.description,
      price_cents: suggestion.suggested_cost_cents
    });
    const index = suggestions.value.indexOf(suggestion);
    if (index > -1) {
      suggestions.value.splice(index, 1);
    }
  } catch (err) {
    suggestionAddError.value = err.response?.data?.error || err.message || 'Failed to add suggested chore';
  } finally {
    addingSuggestion.value = null;
  }
}

async function onEstimatePrice() {
  estimatedPrice.value = await handleEstimatePrice();
}

function formatCentsForDisplay(cents) {
  return `$${(parseInt(cents) / 100).toFixed(2)}`;
}
</script>
