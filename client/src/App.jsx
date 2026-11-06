// EventRelay dashboard. Server state lives in React Query; after mutations
// (replay, revoke, create) we invalidate queries instead of hand-syncing.
import { useState } from 'react';
import { Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LayoutDashboard, Webhook, ListOrdered, KeyRound, LogOut, RotateCcw, Copy, Check,
} from 'lucide-react';
import { api, errorMessage } from './lib/api';

const token = () => localStorage.getItem('eventrelay_token');
const Protected = ({ children }) => (token() ? children : <Navigate to="/login" replace />);

function Shell({ children }) {
  const nav = useNavigate();
  const logout = () => { localStorage.removeItem('eventrelay_token'); nav('/login'); };
  const linkCls = 'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100';
  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 w-56 border-r bg-white p-4">
        <div className="mb-6 flex items-center gap-2 px-2">
          <Webhook className="h-6 w-6 text-indigo-600" />
          <span className="text-lg font-bold">EventRelay</span>
        </div>
        <nav className="space-y-1">
          <Link className={linkCls} to="/"><LayoutDashboard className="h-4 w-4" /> Dashboard</Link>
          <Link className={linkCls} to="/events"><ListOrdered className="h-4 w-4" /> Events</Link>
          <Link className={linkCls} to="/deliveries"><Webhook className="h-4 w-4" /> Deliveries</Link>
          <Link className={linkCls} to="/endpoints"><Webhook className="h-4 w-4" /> Endpoints</Link>
          <Link className={linkCls} to="/api-keys"><KeyRound className="h-4 w-4" /> API Keys</Link>
        </nav>
        <button onClick={logout} className={`${linkCls} mt-6 w-full`}><LogOut className="h-4 w-4" /> Logout</button>
      </aside>
      <main className="ml-56 p-8">{children}</main>
    </div>
  );
}

function Badge({ status }) {
  const colors = {
    succeeded: 'bg-emerald-100 text-emerald-700',
    failed: 'bg-red-100 text-red-700',
    processing: 'bg-amber-100 text-amber-700',
    pending: 'bg-slate-100 text-slate-700',
    retrying: 'bg-blue-100 text-blue-700',
    worker_lost: 'bg-purple-100 text-purple-700',
  };
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${colors[status] || 'bg-slate-100 text-slate-700'}`}>{status}</span>;
}

function Login() {
  const nav = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [err, setErr] = useState('');
  const login = useMutation({
    mutationFn: () => api.post('/auth/login', form),
    onSuccess: (res) => { localStorage.setItem('eventrelay_token', res.data.token); nav('/'); },
    onError: (e) => setErr(errorMessage(e)),
  });
  return (
    <div className="flex min-h-screen items-center justify-center">
      <form className="w-full max-w-sm space-y-4 rounded-2xl border bg-white p-8 shadow-sm"
        onSubmit={(e) => { e.preventDefault(); login.mutate(); }}>
        <h1 className="text-xl font-bold">EventRelay</h1>
        <p className="text-sm text-slate-500">Sign in to your dashboard.</p>
        <input className="w-full rounded-lg border px-3 py-2" placeholder="Email" type="email" required
          value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input className="w-full rounded-lg border px-3 py-2" placeholder="Password" type="password" required
          value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        {err && <p className="text-sm text-red-600">{err}</p>}
        <button className="w-full rounded-lg bg-indigo-600 py-2 font-medium text-white hover:bg-indigo-700" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

function Dashboard() {
  const { data, isLoading } = useQuery({ queryKey: ['stats'], queryFn: () => api.get('/stats/overview').then((r) => r.data) });
  if (isLoading) return <p>Loading…</p>;
  const by = data?.deliveriesByStatus || {};
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Overview</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[['Events', data?.events ?? 0], ['Succeeded', by.succeeded || 0], ['Failed', by.failed || 0], ['Retrying', (by.retrying || 0) + (by.pending || 0)]].map(([label, n]) => (
          <div key={label} className="rounded-2xl border bg-white p-6">
            <p className="text-sm text-slate-500">{label}</p>
            <p className="mt-1 text-3xl font-bold">{n}</p>
          </div>
        ))}
      </div>
      {data?.successRate != null && <p className="mt-4 text-sm text-slate-600">Success rate: {(data.successRate * 100).toFixed(1)}%</p>}
      {!!data?.recentFailures?.length && (
        <>
          <h2 className="mt-8 mb-3 text-lg font-semibold">Recent failures</h2>
          <ul className="space-y-2">
            {data.recentFailures.map((f) => (
              <li key={f.id} className="rounded-lg border bg-white px-4 py-3 text-sm">
                <Badge status={f.status} /> <span className="ml-2 font-medium">{f.event_type}</span>
                <span className="ml-2 text-slate-500">{f.last_error}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Events() {
  const { data, isLoading } = useQuery({ queryKey: ['events'], queryFn: () => api.get('/events?limit=50').then((r) => r.data) });
  if (isLoading) return <p>Loading…</p>;
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Events</h1>
      <div className="overflow-hidden rounded-xl border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500"><tr><th className="px-4 py-2">Type</th><th className="px-4 py-2">ID</th><th className="px-4 py-2">Created</th></tr></thead>
          <tbody>{data?.events?.map((e) => (
            <tr key={e.id} className="border-t"><td className="px-4 py-2 font-medium">{e.event_type}</td><td className="px-4 py-2 font-mono text-xs">{e.id}</td><td className="px-4 py-2">{new Date(e.created_at).toLocaleString()}</td></tr>
          ))}</tbody>
        </table>
        {!data?.events?.length && <p className="px-4 py-8 text-center text-slate-500">No events yet. Ingest one with POST /v1/events.</p>}
      </div>
    </div>
  );
}

function Deliveries() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(null);
  const { data, isLoading } = useQuery({ queryKey: ['deliveries'], queryFn: () => api.get('/deliveries?limit=50').then((r) => r.data) });
  const replay = useMutation({
    mutationFn: (id) => api.post(`/deliveries/${id}/replay`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deliveries'] }),
  });
  if (isLoading) return <p>Loading…</p>;
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Deliveries</h1>
      <div className="space-y-3">
        {data?.deliveries?.map((d) => (
          <div key={d.id} className="rounded-xl border bg-white p-4">
            <div className="flex items-center gap-3">
              <Badge status={d.status} />
              <span className="font-medium">{d.event_type}</span>
              <span className="text-xs text-slate-500">attempts {d.attempt_count} · replays {d.replay_count}</span>
              <span className="ml-auto flex gap-2">
                <button className="text-sm text-indigo-600 hover:underline" onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
                  {expanded === d.id ? 'Hide' : 'Attempts'}
                </button>
                {d.status === 'failed' && (
                  <button className="flex items-center gap-1 text-sm text-indigo-600 hover:underline" disabled={replay.isPending}
                    onClick={() => replay.mutate(d.id)}><RotateCcw className="h-3.5 w-3.5" /> Replay</button>
                )}
              </span>
            </div>
            {expanded === d.id && <AttemptList deliveryId={d.id} />}
          </div>
        ))}
        {!data?.deliveries?.length && <p className="text-slate-500">No deliveries yet.</p>}
      </div>
    </div>
  );
}

function AttemptList({ deliveryId }) {
  const { data } = useQuery({
    queryKey: ['delivery', deliveryId],
    queryFn: () => api.get(`/deliveries/${deliveryId}`).then((r) => r.data),
  });
  if (!data) return <p className="mt-3 text-sm text-slate-500">Loading attempts…</p>;
  return (
    <ul className="mt-3 space-y-1 border-t pt-3 text-sm">
      {data.attempts.map((a) => (
        <li key={a.id} className="flex flex-wrap items-center gap-2">
          <Badge status={a.status} />
          <span>cycle {a.cycle_number} · attempt {a.attempt_number}</span>
          {a.response_status && <span>HTTP {a.response_status}</span>}
          {a.response_time_ms != null && <span>{a.response_time_ms}ms</span>}
          {a.error_message && <span className="text-red-600">{a.error_message}</span>}
        </li>
      ))}
      {!data.attempts.length && <li className="text-slate-500">No attempts recorded yet.</li>}
    </ul>
  );
}

function Endpoints() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', url: '', eventTypes: '' });
  const [created, setCreated] = useState(null);
  const { data } = useQuery({ queryKey: ['endpoints'], queryFn: () => api.get('/endpoints').then((r) => r.data) });
  const create = useMutation({
    mutationFn: () => api.post('/endpoints', {
      name: form.name, url: form.url,
      eventTypes: form.eventTypes.split(',').map((s) => s.trim()).filter(Boolean),
    }),
    onSuccess: (res) => { setCreated(res.data); qc.invalidateQueries({ queryKey: ['endpoints'] }); },
  });
  const del = useMutation({
    mutationFn: (id) => api.delete(`/endpoints/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['endpoints'] }),
  });
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Endpoints</h1>
      {created?.signingSecret && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
          <strong>Signing secret (shown once):</strong> <code className="break-all">{created.signingSecret}</code>
          <p className="mt-1 text-slate-600">Your receiver needs this to verify X-EventRelay-Signature. Save it now — we can't show it again.</p>
        </div>
      )}
      <form className="mb-6 grid gap-3 rounded-xl border bg-white p-4 md:grid-cols-4"
        onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <input className="rounded-lg border px-3 py-2" placeholder="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className="rounded-lg border px-3 py-2 md:col-span-2" placeholder="https://receiver.example.com/webhook" required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        <input className="rounded-lg border px-3 py-2" placeholder="order.created, order.updated" value={form.eventTypes} onChange={(e) => setForm({ ...form, eventTypes: e.target.value })} />
        <button className="rounded-lg bg-indigo-600 py-2 font-medium text-white md:col-span-4" disabled={create.isPending}>Create endpoint</button>
        {create.isError && <p className="text-sm text-red-600 md:col-span-4">{errorMessage(create.error)}</p>}
      </form>
      <div className="space-y-3">
        {data?.endpoints?.map((e) => (
          <div key={e.id} className="flex items-center gap-3 rounded-xl border bg-white p-4">
            <div>
              <p className="font-medium">{e.name} {e.is_active ? '· active' : '· inactive'}</p>
              <p className="text-sm text-slate-500">{e.url}</p>
              <p className="text-xs text-slate-400">{(e.eventTypes || []).join(', ') || 'no subscriptions'}</p>
            </div>
            <button className="ml-auto text-sm text-red-600 hover:underline" onClick={() => del.mutate(e.id)}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ApiKeys() {
  const qc = useQueryClient();
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);
  const { data } = useQuery({ queryKey: ['api-keys'], queryFn: () => api.get('/api-keys').then((r) => r.data) });
  const create = useMutation({
    mutationFn: () => api.post('/api-keys', { name: 'dashboard key' }),
    onSuccess: (res) => { setCreated(res.data); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
  });
  const revoke = useMutation({
    mutationFn: (id) => api.delete(`/api-keys/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">API Keys</h1>
      {created?.rawKey && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
          <strong>API key (shown once):</strong>
          <div className="mt-1 flex items-center gap-2">
            <code className="break-all">{created.rawKey}</code>
            <button className="flex items-center gap-1 text-indigo-600" onClick={() => { navigator.clipboard.writeText(created.rawKey); setCopied(true); }}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-1 text-slate-600">We store only a hash — this is your only chance to see it.</p>
        </div>
      )}
      <button className="mb-6 rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white" disabled={create.isPending} onClick={() => create.mutate()}>
        Create API key
      </button>
      <div className="space-y-3">
        {data?.apiKeys?.map((k) => (
          <div key={k.id} className="flex items-center gap-3 rounded-xl border bg-white p-4">
            <div>
              <p className="font-medium">{k.name} <code className="text-xs text-slate-500">{k.key_prefix}…</code></p>
              <p className="text-xs text-slate-400">last used {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}{k.revoked_at ? ' · revoked' : ''}</p>
            </div>
            {!k.revoked_at && <button className="ml-auto text-sm text-red-600 hover:underline" onClick={() => revoke.mutate(k.id)}>Revoke</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Protected><Shell><Dashboard /></Shell></Protected>} />
      <Route path="/events" element={<Protected><Shell><Events /></Shell></Protected>} />
      <Route path="/deliveries" element={<Protected><Shell><Deliveries /></Shell></Protected>} />
      <Route path="/endpoints" element={<Protected><Shell><Endpoints /></Shell></Protected>} />
      <Route path="/api-keys" element={<Protected><Shell><ApiKeys /></Shell></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
