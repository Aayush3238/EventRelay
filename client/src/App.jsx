// EventRelay dashboard. Server state lives in React Query; after mutations
// (replay, revoke, create) we invalidate queries instead of hand-syncing.
import { useState } from 'react';
import { Routes, Route, Link, NavLink, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LayoutDashboard, Webhook, ListOrdered, KeyRound, LogOut, RotateCcw, Copy, Check,
  Activity, ShieldCheck, Zap, ArrowRight,
} from 'lucide-react';
import { api, errorMessage } from './lib/api';

const token = () => localStorage.getItem('eventrelay_token');
// New visitors land on Sign Up first — most people arriving have no
// account yet, and a dead-end "Invalid email or password" helps nobody.
const Protected = ({ children }) => (token() ? children : <Navigate to="/register" replace />);

const PAGE_TITLES = {
  '/': ['Overview', 'Pipeline health and recent failures at a glance.'],
  '/events': ['Events', 'Every event ingested under your account.'],
  '/deliveries': ['Deliveries', 'Fan-out status and per-attempt audit history.'],
  '/endpoints': ['Endpoints', 'Webhook destinations and their subscriptions.'],
  '/api-keys': ['API Keys', 'Credentials your applications use to submit events.'],
};

function Shell({ children }) {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const logout = () => { localStorage.removeItem('eventrelay_token'); nav('/register'); };
  const [title, subtitle] = PAGE_TITLES[pathname] || PAGE_TITLES['/'];
  const navCls = ({ isActive }) => `flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium transition-colors ${
    isActive ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
  }`;
  return (
    <div className="min-h-screen bg-slate-50">
      {/* Dark ops sidebar (Stitch design system: slate-900 rail) */}
      <aside className="fixed inset-y-0 left-0 flex w-60 flex-col bg-slate-900 text-slate-100">
        <div className="flex items-center gap-2.5 border-b border-slate-800 px-5 py-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-indigo-600">
            <Webhook className="h-4.5 w-4.5 text-white" />
          </span>
          <div>
            <p className="text-[15px] font-semibold tracking-tight">EventRelay</p>
            <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Ops console</p>
          </div>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          <p className="px-3 pb-2 font-mono text-[10px] uppercase tracking-widest text-slate-500">Operations</p>
          <NavLink className={navCls} end to="/"><LayoutDashboard className="h-4 w-4" /> Overview</NavLink>
          <NavLink className={navCls} to="/events"><ListOrdered className="h-4 w-4" /> Events</NavLink>
          <NavLink className={navCls} to="/deliveries"><Activity className="h-4 w-4" /> Deliveries</NavLink>
          <NavLink className={navCls} to="/endpoints"><Webhook className="h-4 w-4" /> Endpoints</NavLink>
          <NavLink className={navCls} to="/api-keys"><KeyRound className="h-4 w-4" /> API Keys</NavLink>
        </nav>
        <div className="border-t border-slate-800 px-5 py-4">
          <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-slate-500">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> At-least-once delivery
          </p>
          <button onClick={logout} className="mt-3 flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium text-slate-400 hover:bg-slate-800 hover:text-slate-100">
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      </aside>
      <div className="ml-60">
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="mx-auto max-w-[1600px] px-8 py-4">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            <p className="text-[13px] text-slate-500">{subtitle}</p>
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] px-8 py-6">{children}</main>
      </div>
    </div>
  );
}

// Semantic status tokens from the Stitch design system: 1px border,
// 10% tint surface, mono label, 6px dot. Same colours everywhere.
const STATUS_STYLES = {
  succeeded: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  failed: 'border-rose-200 bg-rose-50 text-rose-700',
  processing: 'border-amber-200 bg-amber-50 text-amber-700',
  pending: 'border-slate-300 bg-slate-100 text-slate-600',
  retrying: 'border-blue-200 bg-blue-50 text-blue-700',
  worker_lost: 'border-violet-200 bg-violet-50 text-violet-700',
  in_progress: 'border-amber-200 bg-amber-50 text-amber-700',
  retryable_failure: 'border-blue-200 bg-blue-50 text-blue-700',
  terminal_failure: 'border-rose-200 bg-rose-50 text-rose-700',
};
const STATUS_DOT = {
  succeeded: 'bg-emerald-500', failed: 'bg-rose-500', processing: 'bg-amber-500',
  pending: 'bg-slate-400', retrying: 'bg-blue-500', worker_lost: 'bg-violet-500',
  in_progress: 'bg-amber-500', retryable_failure: 'bg-blue-500', terminal_failure: 'bg-rose-500',
};

function Badge({ status }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[11px] font-medium ${STATUS_STYLES[status] || STATUS_STYLES.pending}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status] || 'bg-slate-400'}`} />
      {status}
    </span>
  );
}

const inputCls = 'h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';
const cardCls = 'rounded-lg border border-slate-200 bg-white';

function CopyBtn({ value }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
      title="Copy"
      onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2 p-4">
      {[0, 1, 2].map((i) => <div key={i} className="h-10 animate-pulse rounded bg-slate-100" />)}
    </div>
  );
}

function EmptyState({ children }) {
  return (
    <div className="m-4 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
      {children}
    </div>
  );
}

function StatCard({ label, value, hint, tone }) {
  return (
    <div className={`${cardCls} p-5`}>
      <p className="font-mono text-[11px] uppercase tracking-widest text-slate-500">{label}</p>
      <p className={`tnum mt-2 text-3xl font-semibold tracking-tight ${tone || 'text-slate-900'}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

// Split-screen auth (Stitch design): dark branding panel + form panel.
function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-[45%] flex-col justify-between bg-slate-900 p-10 text-slate-100 lg:flex">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-indigo-600"><Webhook className="h-4.5 w-4.5 text-white" /></span>
          <span className="text-lg font-semibold tracking-tight">EventRelay</span>
        </div>
        <div>
          <h2 className="max-w-md text-3xl font-semibold leading-tight tracking-tight">
            Webhooks that arrive. Every time.
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-slate-400">
            Reliable webhook delivery with at-least-once semantics, signed payloads,
            and a full audit trail for every attempt.
          </p>
          <div className="mt-8 flex items-center gap-3 font-mono text-[11px] text-slate-400">
            <span className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200">Producer</span>
            <ArrowRight className="h-3.5 w-3.5" />
            <span className="rounded border border-indigo-500/40 bg-indigo-600/20 px-2 py-1 text-indigo-200">EventRelay</span>
            <ArrowRight className="h-3.5 w-3.5" />
            <span className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200">Your endpoints</span>
          </div>
          <ul className="mt-8 space-y-3 text-sm text-slate-400">
            <li className="flex gap-2.5"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> Atomic fan-out — event, deliveries and outbox commit together.</li>
            <li className="flex gap-2.5"><Zap className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" /> Exponential backoff with jitter, up to 6 attempts.</li>
            <li className="flex gap-2.5"><Activity className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" /> Every attempt recorded — inspect, replay, recover.</li>
          </ul>
        </div>
        <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 p-4 font-mono text-[11px] leading-relaxed text-slate-400">
{`curl -X POST /v1/events \\
  -H "X-API-Key: er_live_..." \\
  -d '{"type":"order.created","data":{...}}'`}
        </pre>
      </aside>
      <main className="flex flex-1 items-center justify-center bg-slate-50 px-6 py-12">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
      </main>
    </div>
  );
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
    <AuthLayout title="Sign in" subtitle="Welcome back to your delivery console.">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); login.mutate(); }}>
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-slate-700">Email</label>
          <input className={inputCls} placeholder="you@company.com" type="email" required
            value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-slate-700">Password</label>
          <input className={inputCls} placeholder="••••••••" type="password" required
            value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </div>
        {err && <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</p>}
        <button className="h-10 w-full rounded-md bg-indigo-600 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="text-center text-sm text-slate-500">
          No account yet? <Link className="font-medium text-indigo-600 hover:underline" to="/register">Sign up</Link>
        </p>
      </form>
    </AuthLayout>
  );
}

function Register() {
  const nav = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [err, setErr] = useState('');
  const register = useMutation({
    mutationFn: () => api.post('/auth/register', form),
    onSuccess: (res) => { localStorage.setItem('eventrelay_token', res.data.token); nav('/'); },
    onError: (e) => setErr(errorMessage(e)),
  });
  return (
    <AuthLayout title="Create your account" subtitle="Start delivering webhooks reliably in minutes.">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); register.mutate(); }}>
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-slate-700">Name</label>
          <input className={inputCls} placeholder="Ada Lovelace" required
            value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-slate-700">Email</label>
          <input className={inputCls} placeholder="you@company.com" type="email" required
            value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-slate-700">Password</label>
          <input className={inputCls} placeholder="Min 8 characters" type="password" required minLength={8}
            value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </div>
        {err && <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</p>}
        <button className="h-10 w-full rounded-md bg-indigo-600 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60" disabled={register.isPending}>
          {register.isPending ? 'Creating account…' : 'Sign up'}
        </button>
        <p className="text-center text-sm text-slate-500">
          Already have an account? <Link className="font-medium text-indigo-600 hover:underline" to="/login">Sign in</Link>
        </p>
      </form>
    </AuthLayout>
  );
}

function Dashboard() {
  const { data, isLoading } = useQuery({ queryKey: ['stats'], queryFn: () => api.get('/stats/overview').then((r) => r.data) });
  if (isLoading) return <div className={`${cardCls} p-4`}><LoadingRows /></div>;
  const by = data?.deliveriesByStatus || {};
  const pipeline = [
    ['Pending', by.pending || 0, 'bg-slate-400'],
    ['Processing', by.processing || 0, 'bg-amber-500'],
    ['Retrying', by.retrying || 0, 'bg-blue-500'],
    ['Succeeded', by.succeeded || 0, 'bg-emerald-500'],
    ['Failed', by.failed || 0, 'bg-rose-500'],
  ];
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Total events" value={data?.events ?? 0} hint="All time, your account" />
        <StatCard label="Succeeded" value={by.succeeded || 0} tone="text-emerald-600" hint="Delivered (2xx)" />
        <StatCard label="Failed" value={by.failed || 0} tone="text-rose-600" hint="Permanently failed" />
        <StatCard label="In flight" value={(by.retrying || 0) + (by.pending || 0) + (by.processing || 0)} tone="text-blue-600" hint="Pending + processing + retrying" />
      </div>

      <section className={`${cardCls} p-5`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Delivery pipeline</h2>
          {data?.successRate != null && (
            <span className="font-mono text-xs text-slate-500">success rate <span className="tnum font-semibold text-slate-900">{(data.successRate * 100).toFixed(1)}%</span></span>
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
          {pipeline.map(([label, n, dot]) => (
            <span key={label} className="flex items-center gap-2 text-sm text-slate-600">
              <span className={`h-2 w-2 rounded-full ${dot}`} />
              {label} <span className="tnum font-mono font-semibold text-slate-900">{n}</span>
            </span>
          ))}
        </div>
        {data?.successRate != null && (
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.round(data.successRate * 100)}%` }} />
          </div>
        )}
      </section>

      <section className={`${cardCls} overflow-hidden`}>
        <div className="border-b border-slate-200 px-5 py-3.5">
          <h2 className="text-sm font-semibold">Recent failures</h2>
          <p className="text-xs text-slate-500">Permanently failed deliveries — replay them from the Deliveries page.</p>
        </div>
        {!!data?.recentFailures?.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left font-mono text-[11px] uppercase tracking-widest text-slate-500">
                <th className="px-5 py-2.5">Event</th><th className="px-3 py-2.5">Delivery</th>
                <th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5">Error</th><th className="px-5 py-2.5 text-right">Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.recentFailures.map((f) => (
                <tr key={f.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-5 py-3 font-medium">{f.event_type}</td>
                  <td className="px-3 py-3"><span className="flex items-center gap-1 font-mono text-xs text-slate-600"><span className="max-w-36 truncate">{f.id}</span><CopyBtn value={f.id} /></span></td>
                  <td className="px-3 py-3"><Badge status={f.status} /></td>
                  <td className="max-w-64 truncate px-3 py-3 text-slate-500">{f.last_error || '—'}</td>
                  <td className="tnum px-5 py-3 text-right font-mono text-xs text-slate-500">{new Date(f.updated_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState>No failures yet. When a delivery permanently fails, it will show up here for replay.</EmptyState>
        )}
      </section>
    </div>
  );
}

function Events() {
  const { data, isLoading } = useQuery({ queryKey: ['events'], queryFn: () => api.get('/events?limit=50').then((r) => r.data) });
  if (isLoading) return <div className={`${cardCls} p-4`}><LoadingRows /></div>;
  return (
    <div className={`${cardCls} overflow-hidden`}>
      {!!data?.events?.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left font-mono text-[11px] uppercase tracking-widest text-slate-500">
              <th className="px-5 py-2.5">Type</th><th className="px-3 py-2.5">Event ID</th><th className="px-5 py-2.5 text-right">Created</th>
            </tr>
          </thead>
          <tbody>
            {data.events.map((e) => (
              <tr key={e.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-5 py-3 font-medium">{e.event_type}</td>
                <td className="px-3 py-3"><span className="flex items-center gap-1 font-mono text-xs text-slate-600"><span className="max-w-56 truncate">{e.id}</span><CopyBtn value={e.id} /></span></td>
                <td className="tnum px-5 py-3 text-right font-mono text-xs text-slate-500">{new Date(e.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState>No events yet. Ingest one with <code className="font-mono text-xs">POST /v1/events</code> — see USER_MANUAL.md §7.</EmptyState>
      )}
    </div>
  );
}

const STATUS_FILTERS = ['all', 'pending', 'processing', 'retrying', 'succeeded', 'failed'];

function Deliveries() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(null);
  const [filter, setFilter] = useState('all');
  const { data, isLoading } = useQuery({ queryKey: ['deliveries'], queryFn: () => api.get('/deliveries?limit=50').then((r) => r.data) });
  const replay = useMutation({
    mutationFn: (id) => api.post(`/deliveries/${id}/replay`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deliveries'] }),
  });
  if (isLoading) return <div className={`${cardCls} p-4`}><LoadingRows /></div>;
  const rows = (data?.deliveries || []).filter((d) => filter === 'all' || d.status === filter);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-md border px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider ${
              filter === s ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="space-y-3">
        {rows.map((d) => (
          <div key={d.id} className={`${cardCls} overflow-hidden`}>
            <div className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <Badge status={d.status} />
              <span className="font-medium">{d.event_type}</span>
              <span className="flex items-center gap-1 font-mono text-xs text-slate-500"><span className="max-w-40 truncate">{d.id}</span><CopyBtn value={d.id} /></span>
              <span className="tnum text-xs text-slate-500">attempts {d.attempt_count} · replays {d.replay_count}</span>
              <span className="ml-auto flex items-center gap-3">
                {d.last_response_status && <span className="tnum font-mono text-xs text-slate-500">HTTP {d.last_response_status}</span>}
                <button className="text-[13px] font-medium text-indigo-600 hover:underline" onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
                  {expanded === d.id ? 'Hide attempts' : 'Attempts'}
                </button>
                {d.status === 'failed' && (
                  <button className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-2.5 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
                    disabled={replay.isPending} onClick={() => replay.mutate(d.id)}>
                    <RotateCcw className="h-3.5 w-3.5" /> Replay
                  </button>
                )}
              </span>
            </div>
            {expanded === d.id && <AttemptList deliveryId={d.id} />}
          </div>
        ))}
        {!rows.length && <div className={cardCls}><EmptyState>No deliveries{filter !== 'all' ? ` with status "${filter}"` : ' yet'}.</EmptyState></div>}
      </div>
    </div>
  );
}

function AttemptList({ deliveryId }) {
  const { data } = useQuery({
    queryKey: ['delivery', deliveryId],
    queryFn: () => api.get(`/deliveries/${deliveryId}`).then((r) => r.data),
  });
  if (!data) return <p className="border-t border-slate-100 px-5 py-3 text-sm text-slate-500">Loading attempts…</p>;
  return (
    <ol className="border-t border-slate-100 bg-slate-50/60 px-5 py-3">
      {data.attempts.map((a) => (
        <li key={a.id} className="relative flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-slate-200 py-2 pl-4 text-sm">
          <span className={`absolute -left-[5px] top-1/2 h-2 w-2 -translate-y-1/2 rounded-full ${STATUS_DOT[a.status] || 'bg-slate-400'}`} />
          <Badge status={a.status} />
          <span className="font-mono text-xs text-slate-500">cycle {a.cycle_number} · attempt {a.attempt_number}</span>
          {a.response_status && <span className="tnum font-mono text-xs text-slate-600">HTTP {a.response_status}</span>}
          {a.response_time_ms != null && <span className="tnum font-mono text-xs text-slate-500">{a.response_time_ms}ms</span>}
          {a.error_message && <span className="text-[13px] text-rose-600">{a.error_message}</span>}
        </li>
      ))}
      {!data.attempts.length && <li className="py-2 text-sm text-slate-500">No attempts recorded yet.</li>}
    </ol>
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
    <div className="space-y-4">
      {created?.signingSecret && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <strong>Signing secret (shown once):</strong> <code className="break-all font-mono text-xs">{created.signingSecret}</code>
          <p className="mt-1 text-slate-600">Your receiver needs this to verify X-EventRelay-Signature. Save it now — we can't show it again.</p>
        </div>
      )}
      <form className={`${cardCls} grid gap-3 p-4 md:grid-cols-[1fr_2fr_1.5fr_auto]`}
        onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <input className={inputCls} placeholder="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className={inputCls} placeholder="https://receiver.example.com/webhook" required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        <input className={inputCls} placeholder="order.created, order.updated" value={form.eventTypes} onChange={(e) => setForm({ ...form, eventTypes: e.target.value })} />
        <button className="h-9 rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60" disabled={create.isPending}>Create endpoint</button>
        {create.isError && <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 md:col-span-4">{errorMessage(create.error)}</p>}
      </form>
      <div className="space-y-3">
        {data?.endpoints?.map((e) => (
          <div key={e.id} className={`${cardCls} flex flex-wrap items-center gap-3 px-5 py-4`}>
            <span className={`h-2 w-2 rounded-full ${e.is_active ? 'bg-emerald-500' : 'bg-slate-300'}`} />
            <div className="min-w-0">
              <p className="font-medium">{e.name}</p>
              <p className="max-w-md truncate font-mono text-xs text-slate-500">{e.url}</p>
              <p className="mt-0.5 flex flex-wrap gap-1">
                {(e.eventTypes || []).map((t) => (
                  <span key={t} className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">{t}</span>
                ))}
                {!(e.eventTypes || []).length && <span className="text-xs text-slate-400">no subscriptions</span>}
              </p>
            </div>
            <span className="tnum ml-auto font-mono text-xs text-slate-500">timeout {e.timeout_ms}ms · max {e.max_attempts} attempts</span>
            <button className="text-[13px] font-medium text-rose-600 hover:underline" onClick={() => del.mutate(e.id)}>Delete</button>
          </div>
        ))}
        {!data?.endpoints?.length && <div className={cardCls}><EmptyState>No endpoints yet. Create one above to start receiving webhooks.</EmptyState></div>}
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
    <div className="space-y-4">
      {created?.rawKey && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <strong>API key (shown once):</strong>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <code className="break-all rounded border border-amber-200 bg-white px-2 py-1 font-mono text-xs">{created.rawKey}</code>
            <button className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-2.5 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-700" onClick={() => { navigator.clipboard.writeText(created.rawKey); setCopied(true); }}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-1.5 text-slate-600">We store only a hash — this is your only chance to see it.</p>
        </div>
      )}
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">Keys authenticate <code className="font-mono text-xs">POST /v1/events</code> for your applications.</p>
        <button className="h-9 rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60" disabled={create.isPending} onClick={() => create.mutate()}>
          Create API key
        </button>
      </div>
      <div className="space-y-3">
        {data?.apiKeys?.map((k) => (
          <div key={k.id} className={`${cardCls} flex flex-wrap items-center gap-3 px-5 py-4`}>
            <KeyRound className="h-4 w-4 shrink-0 text-slate-400" />
            <div className="min-w-0">
              <p className="font-medium">{k.name} <code className="ml-1 font-mono text-xs text-slate-500">{k.key_prefix}…</code></p>
              <p className="tnum text-xs text-slate-400">last used {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}{k.revoked_at ? ' · revoked' : ''}</p>
            </div>
            {k.revoked_at
              ? <span className="ml-auto rounded border border-rose-200 bg-rose-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-rose-700">revoked</span>
              : <button className="ml-auto text-[13px] font-medium text-rose-600 hover:underline" onClick={() => revoke.mutate(k.id)}>Revoke</button>}
          </div>
        ))}
        {!data?.apiKeys?.length && <div className={cardCls}><EmptyState>No API keys yet. Create one to start sending events.</EmptyState></div>}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/register" element={<Register />} />
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
