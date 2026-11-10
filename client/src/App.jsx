// EventRelay dashboard. Server state lives in React Query; after mutations
// (replay, revoke, create) we invalidate queries instead of hand-syncing.
import { useEffect, useState } from 'react';
import { Routes, Route, Link, NavLink, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LayoutDashboard,
  Webhook,
  ListOrdered,
  KeyRound,
  LogOut,
  RotateCcw,
  Copy,
  Check,
  Activity,
  ShieldCheck,
  Zap,
  ArrowRight,
  WifiOff,
  Clock3,
  AlertTriangle,
  Database,
  Copy as CopyIcon,
  TrendingUp,
  Lock,
  Terminal,
  Braces,
  X,
  ChevronRight,
  Home,
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
  const logout = () => {
    localStorage.removeItem('eventrelay_token');
    nav('/register');
  };
  const [title, subtitle] = PAGE_TITLES[pathname] || PAGE_TITLES['/'];
  const navCls = ({ isActive }) =>
    `flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium transition-colors ${
      isActive ? 'bg-orange-600 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
    }`;
  return (
    <div className="min-h-screen bg-slate-50">
      {/* Dark ops sidebar (Stitch design system: slate-900 rail) */}
      <aside className="fixed inset-y-0 left-0 flex w-60 flex-col bg-slate-900 text-slate-100">
        <div className="flex items-center gap-2.5 border-b border-slate-800 px-5 py-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-orange-600">
            <Webhook className="h-4.5 w-4.5 text-white" />
          </span>
          <div>
            <p className="text-[15px] font-semibold tracking-tight">EventRelay</p>
            <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Ops console</p>
          </div>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          <p className="px-3 pb-2 font-mono text-[10px] uppercase tracking-widest text-slate-500">
            Operations
          </p>
          <Link
            className="flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
            to="/"
          >
            <Home className="h-4 w-4" /> Home page
          </Link>
          <NavLink className={navCls} end to="/dashboard">
            <LayoutDashboard className="h-4 w-4" /> Overview
          </NavLink>
          <NavLink className={navCls} to="/events">
            <ListOrdered className="h-4 w-4" /> Events
          </NavLink>
          <NavLink className={navCls} to="/deliveries">
            <Activity className="h-4 w-4" /> Deliveries
          </NavLink>
          <NavLink className={navCls} to="/endpoints">
            <Webhook className="h-4 w-4" /> Endpoints
          </NavLink>
          <NavLink className={navCls} to="/api-keys">
            <KeyRound className="h-4 w-4" /> API Keys
          </NavLink>
        </nav>
        <div className="border-t border-slate-800 px-5 py-4">
          <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-slate-500">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> At-least-once delivery
          </p>
          <button
            onClick={logout}
            className="mt-3 flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
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
  succeeded: 'bg-emerald-500',
  failed: 'bg-rose-500',
  processing: 'bg-amber-500',
  pending: 'bg-slate-400',
  retrying: 'bg-blue-500',
  worker_lost: 'bg-violet-500',
  in_progress: 'bg-amber-500',
  retryable_failure: 'bg-blue-500',
  terminal_failure: 'bg-rose-500',
};

function Badge({ status }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[11px] font-medium ${STATUS_STYLES[status] || STATUS_STYLES.pending}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status] || 'bg-slate-400'}`} />
      {status}
    </span>
  );
}

const inputCls =
  'h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-orange-600 focus:outline-none focus:ring-1 focus:ring-orange-600';
const cardCls = 'rounded-lg border border-slate-200 bg-white';

function CopyBtn({ value }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
      title="Copy"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2 p-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-10 animate-pulse rounded bg-slate-100" />
      ))}
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
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-orange-600">
            <Webhook className="h-4.5 w-4.5 text-white" />
          </span>
          <span className="text-lg font-semibold tracking-tight">EventRelay</span>
        </div>
        <div>
          <h2 className="max-w-md text-3xl font-semibold leading-tight tracking-tight">
            Webhooks that arrive. Every time.
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-slate-400">
            Reliable webhook delivery with at-least-once semantics, signed payloads, and a full audit trail
            for every attempt.
          </p>
          <div className="mt-8 flex items-center gap-3 font-mono text-[11px] text-slate-400">
            <span className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200">
              Producer
            </span>
            <ArrowRight className="h-3.5 w-3.5" />
            <span className="rounded border border-emerald-600/40 bg-orange-600/20 px-2 py-1 text-emerald-200">
              EventRelay
            </span>
            <ArrowRight className="h-3.5 w-3.5" />
            <span className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200">
              Your endpoints
            </span>
          </div>
          <ul className="mt-8 space-y-3 text-sm text-slate-400">
            <li className="flex gap-2.5">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> Atomic fan-out — event,
              deliveries and outbox commit together.
            </li>
            <li className="flex gap-2.5">
              <Zap className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" /> Exponential backoff with jitter, up
              to 6 attempts.
            </li>
            <li className="flex gap-2.5">
              <Activity className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" /> Every attempt recorded — inspect,
              replay, recover.
            </li>
          </ul>
        </div>
        <pre className="w-full max-w-full whitespace-pre-wrap break-words rounded-lg border border-slate-800 bg-slate-950 p-4 font-mono text-[11px] leading-relaxed text-slate-400">
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
    onSuccess: (res) => {
      localStorage.setItem('eventrelay_token', res.data.token);
      nav('/dashboard');
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  return (
    <AuthLayout title="Sign in" subtitle="Welcome back to your delivery console.">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-slate-700">Email</label>
          <input
            className={inputCls}
            placeholder="you@company.com"
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-slate-700">Password</label>
          <input
            className={inputCls}
            placeholder="••••••••"
            type="password"
            required
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </div>
        {err && (
          <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {err}
          </p>
        )}
        <button
          className="h-10 w-full rounded-md bg-orange-600 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-60"
          disabled={login.isPending}
        >
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="text-center text-sm text-slate-500">
          No account yet?{' '}
          <Link className="font-medium text-orange-700 hover:underline" to="/register">
            Sign up
          </Link>
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
    onSuccess: (res) => {
      localStorage.setItem('eventrelay_token', res.data.token);
      nav('/dashboard');
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  return (
    <AuthLayout title="Create your account" subtitle="Start delivering webhooks reliably in minutes.">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          register.mutate();
        }}
      >
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-slate-700">Name</label>
          <input
            className={inputCls}
            placeholder="Ada Lovelace"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-slate-700">Email</label>
          <input
            className={inputCls}
            placeholder="you@company.com"
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-slate-700">Password</label>
          <input
            className={inputCls}
            placeholder="Min 8 characters"
            type="password"
            required
            minLength={8}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </div>
        {err && (
          <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {err}
          </p>
        )}
        <button
          className="h-10 w-full rounded-md bg-orange-600 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-60"
          disabled={register.isPending}
        >
          {register.isPending ? 'Creating account…' : 'Sign up'}
        </button>
        <p className="text-center text-sm text-slate-500">
          Already have an account?{' '}
          <Link className="font-medium text-orange-700 hover:underline" to="/login">
            Sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}

// ─── Landing page (public, scrollable) ───────────────────────────────────
// Explains the problem EventRelay solves, how it works, and why it's
// reliable — in that order, because nobody cares about features before
// they feel the pain.
function Landing() {
  const [activeSection, setActiveSection] = useState('');
  // Scroll reveal: sections/cards fade up as they enter the viewport.
  useEffect(() => {
    const els = document.querySelectorAll('.reveal');
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('is-visible');
            io.unobserve(e.target);
          }
        }),
      { threshold: 0.12 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  // Scroll-spy: highlight the nav link for the section currently in view.
  useEffect(() => {
    const spy = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) setActiveSection(e.target.id);
        }),
      { rootMargin: '-40% 0px -55% 0px' },
    );
    ['problem', 'how', 'reliability', 'developers'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) spy.observe(el);
    });
    return () => spy.disconnect();
  }, []);

  const navLinkCls = (id) =>
    `relative px-1 py-1 transition-colors ${
      activeSection === id ? 'font-semibold text-orange-700' : 'hover:text-slate-900'
    }`;
  const NavAnchor = ({ id, children }) => (
    <a href={`#${id}`} className={navLinkCls(id)}>
      {children}
      <span
        className={`absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-orange-600 transition-opacity ${activeSection === id ? 'opacity-100' : 'opacity-0'}`}
      />
    </a>
  );

  // Logged-in users can also browse the landing page — they just get a
  // "Dashboard" button in the nav instead of Sign in / Get started.
  const loggedIn = Boolean(token());

  const problems = [
    {
      icon: WifiOff,
      title: 'Receiver is down',
      text: 'Your warehouse service is deploying. The order event is gone — unless someone retries it.',
    },
    {
      icon: Clock3,
      title: 'Requests time out',
      text: 'A slow downstream silently eats the request. Was it processed? You will never know.',
    },
    {
      icon: AlertTriangle,
      title: 'HTTP 500s happen',
      text: 'A brief bug in one service should not mean a lost payment, shipment, or signup.',
    },
    {
      icon: Database,
      title: 'Redis goes away',
      text: 'Queue flushed or restarted? Jobs that only live in Redis disappear with it.',
    },
    {
      icon: Zap,
      title: 'Workers crash mid-delivery',
      text: 'The process dies after the POST but before recording it. Did it send? Unknown.',
    },
    {
      icon: CopyIcon,
      title: 'Duplicate submissions',
      text: 'Retries and double-clicks create two events, two deliveries, and double processing.',
    },
    {
      icon: TrendingUp,
      title: 'Traffic spikes',
      text: '10,000 events at once can overwhelm receivers that were fine at 10.',
    },
    {
      icon: RotateCcw,
      title: 'No way to replay',
      text: "Yesterday's failed delivery needs manual database surgery to send again.",
    },
  ];

  const steps = [
    {
      n: '01',
      title: 'Producer submits',
      text: 'Your app POSTs one event with an API key. EventRelay validates it and checks the idempotency key.',
    },
    {
      n: '02',
      title: 'Atomic fan-out',
      text: 'Event, one delivery per subscribed endpoint, and outbox rows commit in a single Postgres transaction — or not at all.',
    },
    {
      n: '03',
      title: 'Outbox → queue',
      text: 'A dispatcher publishes due outbox rows to BullMQ. If Redis is down, rows wait in Postgres and drain later.',
    },
    {
      n: '04',
      title: 'Signed delivery',
      text: 'Workers claim deliveries with expiring leases, sign with HMAC-SHA256, POST with a timeout, and record every attempt.',
    },
  ];

  const compare = [
    ['Receiver temporarily down', 'Event lost', 'Retried with backoff until it lands'],
    [
      'Worker crashes mid-send',
      'Unknown state, stuck forever',
      'Lease expires → attempt marked worker_lost → re-sent',
    ],
    ['Redis wiped', 'Queued jobs gone', 'Outbox in Postgres + explicit recovery command'],
    ['Same event submitted twice', 'Duplicate deliveries', 'Idempotency key returns the original event'],
    ['"Did they get it?"', 'Guesswork and log archaeology', 'Every attempt stored: status, timing, response'],
    ['Forged webhook', 'Trusted blindly', 'HMAC signature your receiver can verify'],
  ];

  return (
    <div className="min-h-screen bg-[#FAFAF7] text-slate-900">
      {/* ── Nav ── */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-8 px-6 py-3.5">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-orange-600">
              <Webhook className="h-4.5 w-4.5 text-white" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight">EventRelay</span>
          </Link>
          <nav className="hidden items-center gap-6 text-[13px] font-medium text-slate-600 md:flex">
            <NavAnchor id="problem">Problem</NavAnchor>
            <NavAnchor id="how">How it works</NavAnchor>
            <NavAnchor id="reliability">Reliability</NavAnchor>
            <NavAnchor id="developers">Developers</NavAnchor>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {loggedIn ? (
              <>
                <Link
                  to="/dashboard"
                  className="rounded-md bg-orange-600 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-orange-700"
                >
                  Open dashboard
                </Link>
              </>
            ) : (
              <>
                <Link
                  to="/login"
                  className="rounded-md px-3 py-2 text-[13px] font-medium text-slate-700 hover:bg-slate-100"
                >
                  Sign in
                </Link>
                <Link
                  to="/register"
                  className="rounded-md bg-orange-600 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-orange-700"
                >
                  Get started
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="hero-grid border-b border-stone-200 bg-stone-50">
        <div className="mx-auto grid max-w-6xl gap-12 px-6 py-20 lg:grid-cols-2 lg:py-28">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-emerald-800">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-600" /> At-least-once webhook delivery
            </p>
            <h1 className="font-display mt-5 text-6xl leading-[1.02] tracking-tight text-slate-900 lg:text-7xl">
              Webhooks that <em className="italic text-orange-700">arrive.</em>
              <br />
              Every time.
            </h1>
            <p className="mt-5 max-w-lg text-[17px] leading-relaxed text-slate-600">
              Send <strong className="font-semibold text-slate-900">one event</strong> — EventRelay delivers
              it to
              <strong className="font-semibold text-slate-900"> every subscribed endpoint</strong>, with
              automatic retries when a receiver is down and a full delivery history you can inspect and
              replay.
            </p>
            <ul className="mt-4 space-y-1.5 text-sm text-slate-700">
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" /> One{' '}
                <code className="font-mono text-xs">POST /v1/events</code> fans out to all your endpoints
              </li>
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" /> Automatic retries with backoff —
                root through outages for you
              </li>
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" /> Every attempt recorded: status,
                timing, response, replay
              </li>
            </ul>
            <p className="font-hand mt-3 -rotate-1 text-xl text-orange-800">
              no silent data loss. ever. (well — read the fine print ↓)
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                to={loggedIn ? '/dashboard' : '/register'}
                className="flex items-center gap-2 rounded-md bg-orange-600 px-5 py-3 text-sm font-medium text-white hover:bg-orange-700"
              >
                {loggedIn ? 'Open dashboard' : 'Create free account'} <ArrowRight className="h-4 w-4" />
              </Link>
              <a
                href="#how"
                className="rounded-md border border-slate-300 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:border-slate-400"
              >
                How it works
              </a>
            </div>
            <dl className="mt-10 grid grid-cols-3 gap-6 border-t border-slate-200 pt-6">
              {[
                ['6', 'max attempts per delivery'],
                ['~5s → 80s', 'jittered backoff schedule'],
                ['100%', 'attempts recorded & replayable'],
              ].map(([v, l]) => (
                <div key={l}>
                  <dt className="sr-only">{l}</dt>
                  <dd className="tnum text-xl font-semibold">{v}</dd>
                  <dd className="mt-0.5 text-xs text-slate-500">{l}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Terminal / delivery log panel */}
          <div className="relative">
            <div className="font-hand absolute -top-9 right-2 z-10 rotate-3 rounded border border-amber-300 bg-amber-50 px-3 py-1 text-lg text-amber-900 shadow-sm">
              billing retried twice, then landed ✓
            </div>
            <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-xl">
              <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                <span className="ml-2 flex items-center gap-1.5 font-mono text-[11px] text-slate-400">
                  <Terminal className="h-3.5 w-3.5" /> ingest + delivery log
                </span>
              </div>
              <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-relaxed text-slate-300">
                {`$ curl -X POST /v1/events \\
  -H "X-API-Key: er_live_..." \\
  -d '{"type":"order.created","data":{"orderId":"ORD-1001"}}'
→ 202 { "deliveriesCreated": 3 }`}
                <span className="caret-blink text-emerald-400">▋</span>
              </pre>
              <ul className="space-y-px border-t border-slate-800 bg-slate-800/50 p-3 font-mono text-[11px]">
                {[
                  ['warehouse.example.com', 'succeeded', '200 · 142ms'],
                  ['billing.example.com', 'retrying', '503 · attempt 2/6'],
                  ['analytics.example.com', 'succeeded', '200 · 89ms'],
                ].map(([host, st, meta], i) => (
                  <li
                    key={host}
                    className="log-item flex items-center gap-3 rounded bg-slate-900 px-3 py-2"
                    style={{ animationDelay: `${0.3 + i * 0.35}s` }}
                  >
                    <Badge status={st} />
                    <span className="truncate text-slate-300">{host}</span>
                    <span className="tnum ml-auto shrink-0 text-slate-500">{meta}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── Event-type ticker ── */}
      <div className="overflow-hidden border-b border-stone-200 bg-white py-3">
        <div className="marquee-track flex w-max gap-10 whitespace-nowrap font-mono text-[11px] uppercase tracking-widest text-slate-400">
          {[...Array(2)].map((_, dup) => (
            <span key={dup} className="flex gap-10">
              {[
                'order.created',
                'payment.succeeded',
                'user.signup',
                'invoice.paid',
                'shipment.delivered',
                'subscription.cancelled',
                'refund.issued',
                'inventory.low',
              ].map((t) => (
                <span key={t} className="flex items-center gap-10">
                  <span>{t}</span>
                  <span className="h-1 w-1 rounded-full bg-orange-500" />
                </span>
              ))}
            </span>
          ))}
        </div>
      </div>

      {/* ── Problem ── */}
      <section id="problem" className="reveal mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
        <p className="font-mono text-[11px] uppercase tracking-widest text-orange-700">
          [ 01 ] — The problem
        </p>
        <h2 className="font-display mt-2 max-w-2xl text-4xl tracking-tight text-slate-900">
          Webhooks fail in boring ways.{' '}
          <em className="italic text-slate-500">And boring failures lose data.</em>
        </h2>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-slate-600">
          Direct HTTP POSTs from your app to other services break the moment anything hiccups — and in a
          distributed system, something always hiccups.
          <span className="font-hand ml-2 text-lg text-orange-800">the usual suspects ↓</span>
        </p>
        <div className="mt-10 border-t border-slate-200">
          {problems.map((p, i) => (
            <article
              key={p.title}
              className="group grid grid-cols-[3rem_2rem_1fr] items-baseline gap-3 border-b border-slate-200 py-4 transition hover:bg-white sm:grid-cols-[4rem_2rem_14rem_1fr] sm:gap-4"
            >
              <span className="font-mono text-xs text-slate-400 transition group-hover:text-orange-700">
                [{String(i + 1).padStart(2, '0')}]
              </span>
              <p.icon className="h-4.5 w-4.5 self-center text-rose-400 transition group-hover:text-rose-600" />
              <h3 className="text-sm font-semibold">{p.title}</h3>
              <p className="col-span-3 text-[13px] leading-relaxed text-slate-600 sm:col-span-1">{p.text}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ── How it works ── */}
      <section
        id="how"
        className="reveal scroll-mt-20 border-y border-stone-800 bg-stone-950 py-20 text-slate-100"
      >
        <div className="mx-auto max-w-6xl px-6">
          <p className="font-mono text-[11px] uppercase tracking-widest text-amber-400">
            [ 02 ] — How it works
          </p>
          <h2 className="font-display mt-2 max-w-2xl text-4xl tracking-tight">
            Four steps. <em className="italic text-emerald-300">Zero silent data loss.</em>
          </h2>
          <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {steps.map((s, i) => (
              <article key={s.n} className="relative rounded-lg border border-stone-700 bg-stone-900/60 p-5">
                <p className="font-mono text-[11px] text-amber-400">{s.n}</p>
                <h3 className="mt-2 text-[15px] font-semibold">{s.title}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-stone-300">{s.text}</p>
                {i < steps.length - 1 && (
                  <ChevronRight className="absolute -right-3 top-1/2 z-10 hidden h-5 w-5 -translate-y-1/2 text-slate-600 xl:block" />
                )}
              </article>
            ))}
          </div>
          <p className="mt-8 flex flex-wrap items-center gap-2 text-sm text-slate-400">
            <Lock className="h-4 w-4 text-amber-400" />
            Every delivery is HMAC-SHA256 signed. Postgres is the source of truth — Redis is only a to-do
            list. Duplicates are possible by design (at-least-once); receivers dedupe on the delivery ID.
          </p>
        </div>
      </section>

      {/* ── Reliability ── */}
      <section id="reliability" className="reveal mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
        <p className="font-mono text-[11px] uppercase tracking-widest text-orange-700">
          [ 03 ] — Reliability
        </p>
        <h2 className="font-display mt-2 text-4xl tracking-tight">
          Direct POST <em className="italic text-slate-400">vs</em> EventRelay
        </h2>
        <div className="mt-8 overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left font-mono text-[11px] uppercase tracking-widest text-slate-500">
                <th className="px-5 py-3">Scenario</th>
                <th className="px-5 py-3">Direct POST from your app</th>
                <th className="px-5 py-3">With EventRelay</th>
              </tr>
            </thead>
            <tbody>
              {compare.map(([a, b, c], i) => (
                <tr key={a} className={i % 2 ? 'bg-slate-50/60' : 'bg-white'}>
                  <td className="px-5 py-3 font-medium">{a}</td>
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-1.5 text-rose-600">
                      <X className="h-3.5 w-3.5 shrink-0" />
                      {b}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-1.5 text-emerald-700">
                      <Check className="h-3.5 w-3.5 shrink-0" />
                      {c}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-10 grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-white p-6">
            <h3 className="text-sm font-semibold">Retry schedule — exponential backoff + jitter</h3>
            <p className="mt-1 text-[13px] text-slate-600">
              Network errors, timeouts, 408/425/429 and 5xx retry. Other 4xx fail permanently instead of
              hammering your endpoint.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {['Attempt 1 · now', '≈5s', '≈10s', '≈20s', '≈40s', '≈80s'].map((s, i) => (
                <span key={s} className="flex items-center gap-2">
                  <span
                    className={`rounded border px-2.5 py-1 font-mono text-[11px] ${i === 0 ? 'border-emerald-700 bg-orange-600 text-white' : 'border-slate-200 bg-slate-50 text-slate-700'}`}
                  >
                    {s}
                  </span>
                  {i < 5 && <ArrowRight className="h-3.5 w-3.5 text-slate-400" />}
                </span>
              ))}
            </div>
            <p className="mt-3 font-mono text-[11px] text-slate-500">
              capped at 1h · Retry-After honoured · max 6 attempts (configurable)
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-6">
            <h3 className="text-sm font-semibold">Crash & outage recovery</h3>
            <ul className="mt-3 space-y-2.5 text-[13px] text-slate-600">
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                Worker dies mid-delivery → lease expires → attempt marked{' '}
                <code className="font-mono text-xs">worker_lost</code> → re-sent automatically.
              </li>
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                Redis down at ingest → outbox rows wait in Postgres, drain when it returns.
              </li>
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                Redis wiped → recovery command rebuilds the queue from the database.
              </li>
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                Failed delivery? One-click replay starts a new attempt cycle, history preserved.
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ── Developers ── */}
      <section id="developers" className="reveal scroll-mt-20 border-y border-stone-200 bg-stone-50 py-20">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 lg:grid-cols-2">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-widest text-orange-700">
              [ 04 ] — Developers
            </p>
            <h2 className="font-display mt-2 text-4xl tracking-tight">
              Two integrations. <em className="italic text-orange-700">Ten minutes.</em>
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
              Send events with your API key, and verify signed webhooks on the receiving side. No SDK required
              — plain HTTPS in, plain HTTPS out.
            </p>
            <ul className="mt-6 space-y-3 text-sm text-slate-600">
              <li className="flex gap-2">
                <Braces className="mt-0.5 h-4 w-4 shrink-0 text-orange-700" />
                Idempotency-Key header makes producer retries safe by default.
              </li>
              <li className="flex gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-orange-700" />
                X-EventRelay-Signature: HMAC-SHA256 over timestamp + raw body.
              </li>
              <li className="flex gap-2">
                <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-orange-700" />
                Full attempt history and OpenAPI docs in the dashboard.
              </li>
            </ul>
            <Link
              to={loggedIn ? '/dashboard' : '/register'}
              className="mt-8 inline-flex items-center gap-2 rounded-md bg-orange-600 px-5 py-3 text-sm font-medium text-white hover:bg-orange-700"
            >
              {loggedIn ? 'Open dashboard' : 'Get your API key'} <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
            <div className="border-b border-slate-800 px-4 py-2.5 font-mono text-[11px] text-slate-400">
              verify-signature.js
            </div>
            <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-relaxed text-slate-300">
              {`import crypto from 'node:crypto';

const expected = crypto
  .createHmac('sha256', SIGNING_SECRET)
  .update(timestamp + '.' + rawBody)
  .digest('hex');

const ok = crypto.timingSafeEqual(
  Buffer.from(expected, 'hex'),
  Buffer.from(v1, 'hex')
);
// + dedupe on X-EventRelay-Delivery-Id`}
            </pre>
          </div>
        </div>
      </section>

      {/* ── CTA + footer ── */}
      <section className="mx-auto max-w-6xl px-6 py-20 text-center">
        <h2 className="text-3xl font-semibold tracking-tight">Stop losing webhooks.</h2>
        <p className="mx-auto mt-3 max-w-xl text-[15px] text-slate-600">
          Create an account, add an endpoint, send one event — and watch the delivery log do the worrying for
          you.
        </p>
        <Link
          to={loggedIn ? '/dashboard' : '/register'}
          className="mt-8 inline-flex items-center gap-2 rounded-md bg-orange-600 px-6 py-3 text-sm font-medium text-white hover:bg-orange-700"
        >
          {loggedIn ? 'Open dashboard' : 'Create free account'} <ArrowRight className="h-4 w-4" />
        </Link>
      </section>
      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-6 py-6 text-[13px] text-slate-500">
          <span className="flex items-center gap-2">
            <Webhook className="h-4 w-4 text-orange-700" /> EventRelay
          </span>
          <span className="font-mono text-[11px]">
            at-least-once delivery · Postgres source of truth · signed webhooks
          </span>
          <span className="ml-auto flex gap-5">
            <a className="hover:text-slate-900" href="#problem">
              Problem
            </a>
            <a className="hover:text-slate-900" href="#how">
              How it works
            </a>
            <Link className="hover:text-slate-900" to="/login">
              Sign in
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}

function Dashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ['stats'],
    queryFn: () => api.get('/stats/overview').then((r) => r.data),
  });
  if (isLoading)
    return (
      <div className={`${cardCls} p-4`}>
        <LoadingRows />
      </div>
    );
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
        <StatCard
          label="Succeeded"
          value={by.succeeded || 0}
          tone="text-emerald-600"
          hint="Delivered (2xx)"
        />
        <StatCard label="Failed" value={by.failed || 0} tone="text-rose-600" hint="Permanently failed" />
        <StatCard
          label="In flight"
          value={(by.retrying || 0) + (by.pending || 0) + (by.processing || 0)}
          tone="text-blue-600"
          hint="Pending + processing + retrying"
        />
      </div>

      <section className={`${cardCls} p-5`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Delivery pipeline</h2>
          {data?.successRate != null && (
            <span className="font-mono text-xs text-slate-500">
              success rate{' '}
              <span className="tnum font-semibold text-slate-900">
                {(data.successRate * 100).toFixed(1)}%
              </span>
            </span>
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
            <div
              className="h-full rounded-full bg-emerald-500"
              style={{ width: `${Math.round(data.successRate * 100)}%` }}
            />
          </div>
        )}
      </section>

      <section className={`${cardCls} overflow-hidden`}>
        <div className="border-b border-slate-200 px-5 py-3.5">
          <h2 className="text-sm font-semibold">Recent failures</h2>
          <p className="text-xs text-slate-500">
            Permanently failed deliveries — replay them from the Deliveries page.
          </p>
        </div>
        {data?.recentFailures?.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left font-mono text-[11px] uppercase tracking-widest text-slate-500">
                <th className="px-5 py-2.5">Event</th>
                <th className="px-3 py-2.5">Delivery</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5">Error</th>
                <th className="px-5 py-2.5 text-right">Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.recentFailures.map((f) => (
                <tr key={f.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-5 py-3 font-medium">{f.event_type}</td>
                  <td className="px-3 py-3">
                    <span className="flex items-center gap-1 font-mono text-xs text-slate-600">
                      <span className="max-w-36 truncate">{f.id}</span>
                      <CopyBtn value={f.id} />
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <Badge status={f.status} />
                  </td>
                  <td className="max-w-64 truncate px-3 py-3 text-slate-500">{f.last_error || '—'}</td>
                  <td className="tnum px-5 py-3 text-right font-mono text-xs text-slate-500">
                    {new Date(f.updated_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState>
            No failures yet. When a delivery permanently fails, it will show up here for replay.
          </EmptyState>
        )}
      </section>
    </div>
  );
}

function Events() {
  const { data, isLoading } = useQuery({
    queryKey: ['events'],
    queryFn: () => api.get('/events?limit=50').then((r) => r.data),
  });
  if (isLoading)
    return (
      <div className={`${cardCls} p-4`}>
        <LoadingRows />
      </div>
    );
  return (
    <div className={`${cardCls} overflow-hidden`}>
      {data?.events?.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left font-mono text-[11px] uppercase tracking-widest text-slate-500">
              <th className="px-5 py-2.5">Type</th>
              <th className="px-3 py-2.5">Event ID</th>
              <th className="px-5 py-2.5 text-right">Created</th>
            </tr>
          </thead>
          <tbody>
            {data.events.map((e) => (
              <tr key={e.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-5 py-3 font-medium">{e.event_type}</td>
                <td className="px-3 py-3">
                  <span className="flex items-center gap-1 font-mono text-xs text-slate-600">
                    <span className="max-w-56 truncate">{e.id}</span>
                    <CopyBtn value={e.id} />
                  </span>
                </td>
                <td className="tnum px-5 py-3 text-right font-mono text-xs text-slate-500">
                  {new Date(e.created_at).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState>
          No events yet. Ingest one with <code className="font-mono text-xs">POST /v1/events</code> using your
          API key.
        </EmptyState>
      )}
    </div>
  );
}

const STATUS_FILTERS = ['all', 'pending', 'processing', 'retrying', 'succeeded', 'failed'];

function Deliveries() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(null);
  const [filter, setFilter] = useState('all');
  const { data, isLoading } = useQuery({
    queryKey: ['deliveries'],
    queryFn: () => api.get('/deliveries?limit=50').then((r) => r.data),
  });
  const replay = useMutation({
    mutationFn: (id) => api.post(`/deliveries/${id}/replay`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deliveries'] }),
  });
  if (isLoading)
    return (
      <div className={`${cardCls} p-4`}>
        <LoadingRows />
      </div>
    );
  const rows = (data?.deliveries || []).filter((d) => filter === 'all' || d.status === filter);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-md border px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider ${
              filter === s
                ? 'border-emerald-700 bg-orange-600 text-white'
                : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
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
              <span className="flex items-center gap-1 font-mono text-xs text-slate-500">
                <span className="max-w-40 truncate">{d.id}</span>
                <CopyBtn value={d.id} />
              </span>
              <span className="tnum text-xs text-slate-500">
                attempts {d.attempt_count} · replays {d.replay_count}
              </span>
              <span className="ml-auto flex items-center gap-3">
                {d.last_response_status && (
                  <span className="tnum font-mono text-xs text-slate-500">HTTP {d.last_response_status}</span>
                )}
                <button
                  className="text-[13px] font-medium text-orange-700 hover:underline"
                  onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                >
                  {expanded === d.id ? 'Hide attempts' : 'Attempts'}
                </button>
                {d.status === 'failed' && (
                  <button
                    className="flex items-center gap-1.5 rounded-md bg-orange-600 px-2.5 py-1.5 text-[13px] font-medium text-white hover:bg-orange-700 disabled:opacity-60"
                    disabled={replay.isPending}
                    onClick={() => replay.mutate(d.id)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Replay
                  </button>
                )}
              </span>
            </div>
            {expanded === d.id && <AttemptList deliveryId={d.id} />}
          </div>
        ))}
        {!rows.length && (
          <div className={cardCls}>
            <EmptyState>No deliveries{filter !== 'all' ? ` with status "${filter}"` : ' yet'}.</EmptyState>
          </div>
        )}
      </div>
    </div>
  );
}

function AttemptList({ deliveryId }) {
  const { data } = useQuery({
    queryKey: ['delivery', deliveryId],
    queryFn: () => api.get(`/deliveries/${deliveryId}`).then((r) => r.data),
  });
  if (!data)
    return <p className="border-t border-slate-100 px-5 py-3 text-sm text-slate-500">Loading attempts…</p>;
  return (
    <ol className="border-t border-slate-100 bg-slate-50/60 px-5 py-3">
      {data.attempts.map((a) => (
        <li
          key={a.id}
          className="relative flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-slate-200 py-2 pl-4 text-sm"
        >
          <span
            className={`absolute -left-[5px] top-1/2 h-2 w-2 -translate-y-1/2 rounded-full ${STATUS_DOT[a.status] || 'bg-slate-400'}`}
          />
          <Badge status={a.status} />
          <span className="font-mono text-xs text-slate-500">
            cycle {a.cycle_number} · attempt {a.attempt_number}
          </span>
          {a.response_status && (
            <span className="tnum font-mono text-xs text-slate-600">HTTP {a.response_status}</span>
          )}
          {a.response_time_ms != null && (
            <span className="tnum font-mono text-xs text-slate-500">{a.response_time_ms}ms</span>
          )}
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
  const { data } = useQuery({
    queryKey: ['endpoints'],
    queryFn: () => api.get('/endpoints').then((r) => r.data),
  });
  const create = useMutation({
    mutationFn: () =>
      api.post('/endpoints', {
        name: form.name,
        url: form.url,
        eventTypes: form.eventTypes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    onSuccess: (res) => {
      setCreated(res.data);
      qc.invalidateQueries({ queryKey: ['endpoints'] });
    },
  });
  const del = useMutation({
    mutationFn: (id) => api.delete(`/endpoints/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['endpoints'] }),
  });
  return (
    <div className="space-y-4">
      {created?.signingSecret && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <strong>Signing secret (shown once):</strong>{' '}
          <code className="break-all font-mono text-xs">{created.signingSecret}</code>
          <p className="mt-1 text-slate-600">
            Your receiver needs this to verify X-EventRelay-Signature. Save it now — we can&apos;t show it
            again.
          </p>
        </div>
      )}
      <form
        className={`${cardCls} grid gap-3 p-4 md:grid-cols-[1fr_2fr_1.5fr_auto]`}
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input
          className={inputCls}
          placeholder="Name"
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <input
          className={inputCls}
          placeholder="https://receiver.example.com/webhook"
          required
          value={form.url}
          onChange={(e) => setForm({ ...form, url: e.target.value })}
        />
        <input
          className={inputCls}
          placeholder="order.created, order.updated"
          value={form.eventTypes}
          onChange={(e) => setForm({ ...form, eventTypes: e.target.value })}
        />
        <button
          className="h-9 rounded-md bg-orange-600 px-4 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-60"
          disabled={create.isPending}
        >
          Create endpoint
        </button>
        {create.isError && (
          <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 md:col-span-4">
            {errorMessage(create.error)}
          </p>
        )}
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
                  <span
                    key={t}
                    className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-600"
                  >
                    {t}
                  </span>
                ))}
                {!(e.eventTypes || []).length && (
                  <span className="text-xs text-slate-400">no subscriptions</span>
                )}
              </p>
            </div>
            <span className="tnum ml-auto font-mono text-xs text-slate-500">
              timeout {e.timeout_ms}ms · max {e.max_attempts} attempts
            </span>
            <button
              className="text-[13px] font-medium text-rose-600 hover:underline"
              onClick={() => del.mutate(e.id)}
            >
              Delete
            </button>
          </div>
        ))}
        {!data?.endpoints?.length && (
          <div className={cardCls}>
            <EmptyState>No endpoints yet. Create one above to start receiving webhooks.</EmptyState>
          </div>
        )}
      </div>
    </div>
  );
}

function ApiKeys() {
  const qc = useQueryClient();
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);
  const { data } = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api.get('/api-keys').then((r) => r.data),
  });
  const create = useMutation({
    mutationFn: () => api.post('/api-keys', { name: 'dashboard key' }),
    onSuccess: (res) => {
      setCreated(res.data);
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
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
            <code className="break-all rounded border border-amber-200 bg-white px-2 py-1 font-mono text-xs">
              {created.rawKey}
            </code>
            <button
              className="flex items-center gap-1.5 rounded-md bg-orange-600 px-2.5 py-1.5 text-[13px] font-medium text-white hover:bg-orange-700"
              onClick={() => {
                navigator.clipboard.writeText(created.rawKey);
                setCopied(true);
              }}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{' '}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-1.5 text-slate-600">We store only a hash — this is your only chance to see it.</p>
        </div>
      )}
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          Keys authenticate <code className="font-mono text-xs">POST /v1/events</code> for your applications.
        </p>
        <button
          className="h-9 rounded-md bg-orange-600 px-4 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-60"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          Create API key
        </button>
      </div>
      <div className="space-y-3">
        {data?.apiKeys?.map((k) => (
          <div key={k.id} className={`${cardCls} flex flex-wrap items-center gap-3 px-5 py-4`}>
            <KeyRound className="h-4 w-4 shrink-0 text-slate-400" />
            <div className="min-w-0">
              <p className="font-medium">
                {k.name} <code className="ml-1 font-mono text-xs text-slate-500">{k.key_prefix}…</code>
              </p>
              <p className="tnum text-xs text-slate-400">
                last used {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}
                {k.revoked_at ? ' · revoked' : ''}
              </p>
            </div>
            {k.revoked_at ? (
              <span className="ml-auto rounded border border-rose-200 bg-rose-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-rose-700">
                revoked
              </span>
            ) : (
              <button
                className="ml-auto text-[13px] font-medium text-rose-600 hover:underline"
                onClick={() => revoke.mutate(k.id)}
              >
                Revoke
              </button>
            )}
          </div>
        ))}
        {!data?.apiKeys?.length && (
          <div className={cardCls}>
            <EmptyState>No API keys yet. Create one to start sending events.</EmptyState>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/register" element={<Register />} />
      <Route path="/login" element={<Login />} />
      <Route
        path="/dashboard"
        element={
          <Protected>
            <Shell>
              <Dashboard />
            </Shell>
          </Protected>
        }
      />
      <Route
        path="/events"
        element={
          <Protected>
            <Shell>
              <Events />
            </Shell>
          </Protected>
        }
      />
      <Route
        path="/deliveries"
        element={
          <Protected>
            <Shell>
              <Deliveries />
            </Shell>
          </Protected>
        }
      />
      <Route
        path="/endpoints"
        element={
          <Protected>
            <Shell>
              <Endpoints />
            </Shell>
          </Protected>
        }
      />
      <Route
        path="/api-keys"
        element={
          <Protected>
            <Shell>
              <ApiKeys />
            </Shell>
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
