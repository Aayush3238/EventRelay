// Single axios instance: attaches the JWT + a requestId to every call so a
// user screenshot of an error maps straight to a server log line.
import axios from 'axios';

export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || '' });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('eventrelay_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (!config.headers['X-Request-Id']) {
    config.headers['X-Request-Id'] = crypto.randomUUID();
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('eventrelay_token');
      if (window.location.pathname !== '/login') window.location.href = '/login';
    }
    return Promise.reject(err);
  },
);

export function errorMessage(err) {
  return err.response?.data?.error?.message || err.message || 'Something went wrong';
}
