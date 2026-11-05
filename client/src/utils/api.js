import axios from 'axios';

const api = axios.create({
  baseURL: '/api'
});

// Add JWT token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle authentication failures
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const isInvalidSession = error.response?.status === 403 &&
      error.response.data?.error === 'Invalid or expired token';
    if ((error.response?.status === 401 || isInvalidSession) && !error.config?.url?.endsWith('/auth/login')) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;
