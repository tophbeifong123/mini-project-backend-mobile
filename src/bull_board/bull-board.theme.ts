import type { UIConfig } from '@bull-board/api/typings/app';

/**
 * หน้าตาของ Bull-Board (§9.1 / deliverable §9 "Load Test Dashboard")
 *
 * ทั้งไฟล์นี้เป็น **การตกแต่งล้วนๆ** ไม่มีผลต่อ invariant ใดใน CLAUDE.md §4
 * bull-board 9.x รับ design token ตามสัญญาแบบ shadcn แล้วแปะเป็น CSS custom property `--<name>`
 * ดังนั้นค่าที่ใส่ต้องเป็น "CSS value" ตรงๆ (hex / rem / font stack) ไม่ใช่ชื่อคลาส
 */

/** โลโก้สายฟ้า (flash sale) — ฝังเป็น data URI จะได้ไม่ต้องเปิด static route เพิ่ม */
function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

const BOLT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><rect width="24" height="24" rx="6" fill="#e11d48"/><g transform="translate(3.6 3.6) scale(0.7)"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" fill="#fff"/></g></svg>`;

const BOLT_MUTED_SVG = BOLT_SVG.replace('#e11d48', '#64748b');

const FONT_SANS =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'Noto Sans Thai', Roboto, sans-serif";
const FONT_MONO =
  "ui-monospace, 'JetBrains Mono', 'Cascadia Mono', Consolas, 'Courier New', monospace";

/** สีของแต่ละสถานะ — ใช้ชุดเดียวกันทั้ง light/dark เพื่อให้ภาพในรายงานอ่านง่ายเหมือนกัน */
const STATUS_TOKENS = {
  'status-completed': '#16a34a',
  'status-active': '#2563eb',
  'status-waiting': '#f59e0b',
  'status-waiting-children': '#0d9488',
  'status-prioritized': '#0891b2',
  'status-delayed': '#7c3aed',
  'status-paused': '#64748b',
  'status-failed': '#dc2626',
} as const;

const CHART_TOKENS = {
  'chart-1': '#e11d48',
  'chart-2': '#2563eb',
  'chart-3': '#16a34a',
  'chart-4': '#f59e0b',
  'chart-5': '#7c3aed',
} as const;

export const BOARD_THEME: NonNullable<UIConfig['theme']> = {
  light: {
    background: '#f5f6f8',
    foreground: '#0f172a',
    card: '#ffffff',
    'card-foreground': '#0f172a',
    popover: '#ffffff',
    'popover-foreground': '#0f172a',
    primary: '#e11d48',
    'primary-foreground': '#ffffff',
    secondary: '#eef1f5',
    'secondary-foreground': '#0f172a',
    muted: '#f1f5f9',
    'muted-foreground': '#64748b',
    accent: '#fff1f2',
    'accent-foreground': '#9f1239',
    'state-hover': '#f1f5f9',
    'state-selected': '#fff1f2',
    'state-selected-hover': '#ffe4e6',
    'state-selected-foreground': '#9f1239',
    destructive: '#dc2626',
    'destructive-foreground': '#ffffff',
    border: '#e2e8f0',
    input: '#e2e8f0',
    ring: '#e11d48',
    radius: '0.7rem',
    // sidebar เป็นแถบเข้มตัดกับเนื้อหาสว่าง — ทำให้ภาพแคปหน้าจอมีจุดยึดสายตา
    sidebar: '#0f172a',
    'sidebar-foreground': '#cbd5e1',
    'sidebar-primary': '#e11d48',
    'sidebar-primary-foreground': '#ffffff',
    'sidebar-accent': '#1e293b',
    'sidebar-accent-foreground': '#f8fafc',
    'sidebar-state-hover': '#1e293b',
    'sidebar-state-selected': '#881337',
    'sidebar-state-selected-hover': '#9f1239',
    'sidebar-state-selected-foreground': '#ffffff',
    'sidebar-border': '#1e293b',
    'sidebar-ring': '#e11d48',
    'font-sans': FONT_SANS,
    'font-mono': FONT_MONO,
    ...STATUS_TOKENS,
    ...CHART_TOKENS,
  },
  dark: {
    background: '#0b1120',
    foreground: '#e2e8f0',
    card: '#111a2e',
    'card-foreground': '#e2e8f0',
    popover: '#111a2e',
    'popover-foreground': '#e2e8f0',
    primary: '#fb7185',
    'primary-foreground': '#0b1120',
    secondary: '#1e293b',
    'secondary-foreground': '#e2e8f0',
    muted: '#172033',
    'muted-foreground': '#94a3b8',
    accent: '#2a1120',
    'accent-foreground': '#fda4af',
    'state-hover': '#172033',
    'state-selected': '#2a1120',
    'state-selected-hover': '#3f1526',
    'state-selected-foreground': '#fda4af',
    destructive: '#f87171',
    'destructive-foreground': '#0b1120',
    border: '#1e293b',
    input: '#1e293b',
    ring: '#fb7185',
    radius: '0.7rem',
    sidebar: '#070c17',
    'sidebar-foreground': '#94a3b8',
    'sidebar-primary': '#fb7185',
    'sidebar-primary-foreground': '#070c17',
    'sidebar-accent': '#111a2e',
    'sidebar-accent-foreground': '#e2e8f0',
    'sidebar-state-hover': '#111a2e',
    'sidebar-state-selected': '#4c0519',
    'sidebar-state-selected-hover': '#881337',
    'sidebar-state-selected-foreground': '#ffe4e6',
    'sidebar-border': '#1e293b',
    'sidebar-ring': '#fb7185',
    'font-sans': FONT_SANS,
    'font-mono': FONT_MONO,
    ...STATUS_TOKENS,
    ...CHART_TOKENS,
  },
};

export const BOARD_LOGO = svgDataUri(BOLT_SVG);
export const BOARD_FAVICON = {
  default: svgDataUri(BOLT_SVG),
  alternative: svgDataUri(BOLT_MUTED_SVG),
};
