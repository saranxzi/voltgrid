import { io, Socket } from 'socket.io-client';

// Determine backend URL dynamically based on current origin/host and environment
const getApiBase = () => {
  if (import.meta.env?.VITE_API_URL) {
    return `${import.meta.env.VITE_API_URL}/api`;
  }
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    return `${protocol}//${hostname}:5000/api`;
  }
  return '/api';
};

const getSocketBase = () => {
  if (import.meta.env?.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    return `${protocol}//${hostname}:5000`;
  }
  return 'http://localhost:5000';
};

const API_BASE = getApiBase();
const SOCKET_BASE = getSocketBase();

export const getAuthToken = (): string | null => {
  return localStorage.getItem('voltgrid_token');
};

export const setAuthToken = (token: string): void => {
  localStorage.setItem('voltgrid_token', token);
};

export const clearAuthToken = (): void => {
  localStorage.removeItem('voltgrid_token');
};

const customFetch = async (endpoint: string, options: RequestInit = {}) => {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {})
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const url = `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers
  });

  const contentType = response.headers.get('content-type') || '';
  let data: any = {};
  if (contentType.includes('application/json')) {
    data = await response.json();
  } else {
    const text = await response.text();
    data = { error: text || `HTTP ${response.status} ${response.statusText}` };
  }

  if (!response.ok) {
    throw new Error(data.error || data.message || `Request failed with status ${response.status}`);
  }

  return data;
};

// API Services
export const api = {
  // Auth
  login: (credentials: { email: string; password: string }) =>
    customFetch('/auth/login', { method: 'POST', body: JSON.stringify(credentials) }),
  quickLogin: (email: string) =>
    customFetch('/auth/quick-login', { method: 'POST', body: JSON.stringify({ email }) }),
  registerDriver: (payload: any) =>
    customFetch('/auth/register', { method: 'POST', body: JSON.stringify(payload) }),
  getMe: () => customFetch('/auth/me'),

  // Stations
  getStations: () => customFetch('/stations'),
  getStationById: (id: string) => customFetch(`/stations/${id}`),
  getTariffs: () => customFetch('/stations/tariffs'),

  // Reservations
  bookReservation: (payload: any) =>
    customFetch('/reservations/book', { method: 'POST', body: JSON.stringify(payload) }),
  cancelReservation: (id: string) =>
    customFetch(`/reservations/${id}`, { method: 'DELETE' }),
  getMyReservations: () => customFetch('/reservations/my-reservations'),
  completeSession: (id: string, actualEnergyKwh: number) =>
    customFetch(`/reservations/${id}/complete`, { method: 'POST', body: JSON.stringify({ actualEnergyKwh }) }),

  // Tickets
  getTickets: (params?: { status?: string; bayId?: string }) => {
    const query = new URLSearchParams(params as any).toString();
    return customFetch(`/tickets${query ? `?${query}` : ''}`);
  },
  createTicket: (payload: any) =>
    customFetch('/tickets', { method: 'POST', body: JSON.stringify(payload) }),
  claimTicket: (id: string) =>
    customFetch(`/tickets/${id}/claim`, { method: 'PATCH' }),
  resolveTicket: (id: string) =>
    customFetch(`/tickets/${id}/resolve`, { method: 'PATCH' }),

  // Analytics
  getLeaderboard: () => customFetch('/analytics/leaderboard'),
  getGridHierarchy: () => customFetch('/analytics/grid-hierarchy'),
  getStationPerformance: () => customFetch('/analytics/station-performance'),
  getUtilizationTrends: () => customFetch('/analytics/utilization-trends'),
  refreshMaterializedView: () => customFetch('/analytics/refresh-view', { method: 'POST' }),

  // Live SQL Terminal & Console
  getSqlHistory: () => customFetch('/sql/history'),
  executeSql: (query: string) =>
    customFetch('/sql/execute', { method: 'POST', body: JSON.stringify({ query }) })
};

// WebSocket Singleton
export let socket: Socket | null = null;

export const initSocketClient = (): Socket => {
  if (!socket) {
    socket = io(SOCKET_BASE, {
      transports: ['websocket', 'polling']
    });
  }
  return socket;
};
