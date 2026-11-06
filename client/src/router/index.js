import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  {
    path: '/',
    name: 'Home',
    component: () => import('../pages/HomePage.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/login',
    name: 'Login',
    component: () => import('../pages/LoginPage.vue')
  },
  {
    path: '/reset-password',
    name: 'PasswordReset',
    component: () => import('../pages/PasswordResetPage.vue')
  },
  {
    path: '/register',
    name: 'Register',
    component: () => import('../pages/RegisterPage.vue')
  },
  {
    path: '/chores',
    name: 'Chores',
    component: () => import('../pages/ChoresPage.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/supplies',
    name: 'Supplies',
    component: () => import('../pages/SuppliesPage.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/chore-dashboard',
    name: 'ChoreDashboard',
    component: () => import('../views/ChoreDashboard.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/ledger',
    name: 'Ledger',
    component: () => import('../pages/LedgerPage.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/ai-suggestions',
    name: 'AISuggestions',
    component: () => import('../pages/AISuggestionsPage.vue'),
    meta: { requiresAuth: true }
  }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

// Navigation guard for auth
router.beforeEach((to, from, next) => {
  const token = localStorage.getItem('token');
  if (to.meta.requiresAuth && !token) {
    next('/login');
  } else {
    next();
  }
});

export default router;
