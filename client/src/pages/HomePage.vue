<template>
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div class="text-center mb-8">
      <h1 class="text-3xl font-bold text-gray-800">Roommate Chore List</h1>
      <p class="text-gray-600 mt-2">Manage chores, track payments, and keep your home harmonious</p>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <router-link
          to="/chores"
          class="bg-white rounded-xl shadow-md p-6 hover:shadow-lg transition"
      >
        <div class="text-4xl mb-4">📋</div>
        <h2 class="text-xl font-semibold text-gray-800">Chores</h2>
        <p class="text-gray-600 mt-2">Create, assign, and complete household chores</p>
      </router-link>

      <router-link
          to="/ledger"
          class="bg-white rounded-xl shadow-md p-6 hover:shadow-lg transition"
      >
        <div class="text-4xl mb-4">💰</div>
        <h2 class="text-xl font-semibold text-gray-800">Ledger & IOUs</h2>
        <p class="text-gray-600 mt-2">Track who owes whom and settle up</p>
      </router-link>

      <router-link
        to="/ai-suggestions"
        class="bg-white rounded-xl shadow-md p-6 hover:shadow-lg transition"
      >
        <div class="text-4xl mb-4">🤖</div>
        <h2 class="text-xl font-semibold text-gray-800">AI Suggestions</h2>
        <p class="text-gray-600 mt-2">Get smart chore recommendations</p>
      </router-link>
    </div>
  </div>
</template>
