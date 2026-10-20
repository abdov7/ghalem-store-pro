// Shared validators (CONTRACT.md §2). All user-facing errors are in Arabic.
const PLAYER_ID_RE = /^[\p{L}\p{N} _\-#.,@]{3,64}$/u;
const EXTRA_VALUE_RE = /^[\p{L}\p{N} _\-#.,@]{1,64}$/u;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDER_NO_RE = /^GS-\d{8}-[A-Z0-9]{4}$/;
const GAME_ID_RE = /^[a-z0-9-]{1,32}$/;
const TRANSFER_REF_RE = /^[^\p{C}]{4,64}$/u;

export const STATUS_AR = {
  awaiting_payment: 'بانتظار الدفع',
  under_review: 'قيد مراجعة الدفع',
  paid: 'تم الدفع',
  shipped: 'تم الشحن',
  rejected: 'مرفوض',
};

export const ORDER_TRANSITIONS = {
  awaiting_payment: ['under_review', 'rejected'],
  under_review: ['paid', 'rejected', 'awaiting_payment'],
  paid: ['shipped'],
  shipped: [],
  rejected: [],
};

export const ORDER_STATUSES = Object.keys(STATUS_AR);

export const SETTING_KEYS = [
  'store_name',
  'whatsapp_number',
  'support_text',
  'pay_ccp_label',
  'pay_ccp_number',
  'pay_baridimob_label',
  'pay_baridimob_number',
  'payment_instructions_ar',
];

export const PUBLIC_SETTING_KEYS = ['store_name', 'whatsapp_number', 'support_text'];

export function isValidPlayerId(v) {
  return typeof v === 'string' && PLAYER_ID_RE.test(v);
}

export function isValidExtraValue(v) {
  return v === undefined || v === null || v === '' || (typeof v === 'string' && EXTRA_VALUE_RE.test(v));
}

export function isValidQty(v) {
  return Number.isInteger(v) && v >= 1 && v <= 10;
}

export function isValidPaymentMethod(v) {
  return v === 'ccp' || v === 'baridimob';
}

export function isValidUuidV4(v) {
  return typeof v === 'string' && UUID_V4_RE.test(v);
}

export function isValidOrderNo(v) {
  return typeof v === 'string' && ORDER_NO_RE.test(v);
}

export function isValidGameId(v) {
  return typeof v === 'string' && GAME_ID_RE.test(v);
}

export function isValidTransferRef(v) {
  return typeof v === 'string' && TRANSFER_REF_RE.test(v);
}

export function isValidCustomerNote(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.length <= 500);
}

export function isValidOrderStatus(v) {
  return ORDER_STATUSES.includes(v);
}

export function canTransition(from, to) {
  return Boolean(ORDER_TRANSITIONS[from] && ORDER_TRANSITIONS[from].includes(to));
}

// Escape %, _ and \ for use inside a SQL LIKE pattern.
export function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function isIsoDateString(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}
