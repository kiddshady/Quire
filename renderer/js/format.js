/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — formato
   Todo número que ve un humano pasa por acá. No es cosmética: si el formateo
   vive desperdigado, tarde o temprano dos vistas muestran el mismo dato
   distinto y no hay forma de saber cuál está bien.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Cambialo si tu app no es para acá. Afecta relojes y fechas. */
export const locale = { tag: 'es-AR' };

/** Duración legible: 840ms · 2.4s · 3m 07s · 1h 12m */
export function fmtDur(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Números grandes sin ruido: 842 · 4.2k · 61k · 1.3M */
export function fmtNum(n) {
  if (!n) return '0';
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  if (abs < 1_000_000) return `${(n / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Tamaño de archivo en base 1024 (que es lo que muestra el explorador). */
export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(Math.abs(n)) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v.toFixed(i === 0 ? 0 : v < 10 ? 1 : 0)} ${u[i]}`;
}

/** Dinero: con más decimales cuando el monto es chico, para que no diga 0.00. */
export function fmtMoney(n, { currency = 'USD' } = {}) {
  if (!n) return `${currency} 0.00`;
  return `${currency} ${Math.abs(n) < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

export function fmtClock(ts) {
  if (!ts) return '—';
  const d = typeof ts === 'string' ? new Date(ts) : new Date(Number(ts));
  return d.toLocaleTimeString(locale.tag, { hour12: false });
}

export function fmtDate(ts, { withTime = false } = {}) {
  if (!ts) return '—';
  const d = typeof ts === 'string' ? new Date(ts) : new Date(Number(ts));
  return d.toLocaleDateString(locale.tag, {
    day: '2-digit', month: 'short', year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  });
}

/** "hace 2 min" — para que nadie tenga que restar fechas mentalmente. */
export function relTime(ts) {
  if (!ts) return 'nunca';
  const diff = Date.now() - Number(ts);
  if (diff < 0) return 'recién';
  const s = Math.round(diff / 1000);
  if (s < 45) return 'recién';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ayer' : `hace ${d} días`;
}

/** Iniciales para un monograma cuando no hay avatar propio. */
export function monogram(name = '') {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '··';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** "1 archivo" / "3 archivos" — el plural también es formato. */
export function plural(n, singular, plural_ = `${singular}s`) {
  return `${n} ${n === 1 ? singular : plural_}`;
}

/** Recorta por el medio, que es donde una ruta larga tiene lo que no importa. */
export function ellipsize(text, max = 48) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (max - 1 - head))}`;
}
