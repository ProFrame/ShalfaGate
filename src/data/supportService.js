// Support — company-scoped ticket desk.
//
// Built on the SAME public.support_tickets/public.support_messages tables and
// RPCs as the platform operator's own SupportConsole.jsx
// (src/components/platform/SupportConsole.jsx + platformService.js), but
// every function in this file is tenant-scoped, never operator-scoped — see
// migration 202608040018 §3/§4 for the tables/RPCs/RLS, revised by
// 202608050030 (the reply e-mail now carries access_token) and 202608050038
// (the reply notification is routed through the shared public.notify()
// instead of a raw insert). This file is the only thing
// SupportPanel.jsx/SupportTickets.jsx ever call — neither imports supabase.
//
// Real permission gates, read from the migrations rather than assumed (the
// task that built this file was explicit that the gate on each RPC had to be
// read, not paraphrased):
//
//   support_ticket_create_internal(p_payload) — requires Support.Manage.
//     This is NOT a "raise your own ticket" endpoint open to any employee;
//     migration 018 §4's own comment says so directly: "the plan reserves
//     this for the System Administrator, which is expressed as the
//     Support.Manage permission, never as a role code." createMyTicket()
//     below calls it as-is and lets PERMISSION_DENIED surface through
//     supportErrorMessage() rather than hiding the form, mirroring this
//     codebase's established convention for an action that only some holders
//     of a screen can actually use (see OperationsListAdmin.jsx's own
//     header). Support.Manage is granted by default to PLATFORM_ADMIN and
//     SYSTEM_ADMIN in every tenant (migration 012 §15, reinforced by 018 §1)
//     — the same two roles that reach PORTAL_SUPPORT/ADMIN_SUPPORT at all
///    (both rows carry min_role_rank 4) — so the common case simply works; a
//     company that regrants roles/screens differently is the real, not
//     theoretical, case this falls back for.
//     The public.support_ticket_create(p_payload) RPC (anon, the marketing
//     site's own /support page) was considered instead — it is open to
//     anyone, but it always files the ticket under platform_tenant_id() with
//     no requester_user_id set, so it can never produce a row this company's
//     own tenant-scoped reads, or that same employee's requester_user_id-
//     scoped reads, could see again. Not usable here.
//   support_reply(p_ticket_id, p_body, p_is_internal) — the ticket's own
//     requester (requester_user_id = auth.uid()), a Support.Manage holder in
//     the ticket's own tenant, or the platform operator. p_is_internal is
//     silently dropped unless the caller is the operator (the migration's
//     own `v_internal := ... and v_is_operator`), so a company caller passing
//     true simply produces an ordinary, visible reply.
//   support_ticket_set_status(p_ticket_id, p_status) — the platform operator
//     OR a Support.Manage holder in the ticket's own tenant. Safe to expose
//     in the company admin screen.
//   support_ticket_assign(p_ticket_id, p_user_id) — the platform operator
//     ONLY. There is no tenant/Support.Manage branch at all, so a company
//     admin can never succeed here no matter what they hold. SupportPanel.jsx
//     therefore wires no control to it — mirrors OperationsListAdmin.jsx's
//     own documented choice to leave out an action that belongs to a
//     different screen's scope, rather than render a button that would fail
//     for every caller, forever. Exported here anyway because the task that
//     built this file calls for it, and so a future operator-facing screen
//     has it ready to reuse.
//   support_ticket_detail(p_ticket_id) — singular: one ticket plus its
//     thread, for the same three audiences as support_reply(). This is NOT a
//     list endpoint, so loadMyTickets()/loadCompanyTickets() below read
//     public.support_tickets directly instead, under its own RLS policies
//     ("support readers read tickets" / "tenant isolation", migration 018
//     §3) — a plain table read, capped and ordered client-side like every
//     other list in src/data/*.js.
//
// Every direct table read below filters is_deleted=false explicitly. Neither
// RLS policy on support_tickets checks it (unlike every read RPC, which
// does) — nothing in the schema ever sets it true today, but a direct read
// should still match the RPCs' own behaviour rather than assume the column
// is dead.
//
// `source` is never read, rendered or filtered on in this file on purpose:
// the only path that ever produces source='Public' (support_ticket_create(),
// the anonymous public-site RPC) always files the ticket under
// platform_tenant_id(), never under a real company's own tenant_id — so a
// tenant-scoped read (RLS: tenant_id = current_tenant_id()) can only ever
// return source='InApp' rows. See migration 018 §3's own header comment.
//
// { data, error } everywhere, never throws. useLocalData mirrors the same
// shape from a localStorage store, same contract as every other
// src/data/*.js file (see operationsService.js's own header).

import { supabase, useLocalData } from '../lib/supabaseClient';
import { extractScreamingSnakeCode, makeAsError } from './serviceEnvelope';

export const SUPPORT_TICKET_CATEGORIES = ['Technical', 'Billing', 'Feature', 'Account', 'Other'];
export const SUPPORT_TICKET_PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];
export const SUPPORT_TICKET_STATUSES = ['Open', 'InProgress', 'Answered', 'Closed'];

const asError = makeAsError('SUPPORT_REQUEST_FAILED');
const ok = (data) => ({ data, error: null });
const ko = (value) => ({ data: null, error: asError(value) });

const run = async (build) => {
  if (!supabase) return ko('SERVICE_NOT_CONFIGURED');
  try {
    const { data, error } = await build();
    if (error) return ko(error);
    return ok(data);
  } catch (error) {
    return ko(error);
  }
};

const runList = async (build) => {
  const { data, error } = await run(build);
  if (error) return { data: null, error };
  return ok(Array.isArray(data) ? data : []);
};

const callRpc = async (name, params) => run(() => supabase.rpc(name, params));

/** Same mapping convention as operationsErrorMessage()/safetyErrorMessage()/assetsErrorMessage(). */
export const supportErrorMessage = (t, error) => {
  if (!error) return '';
  const code = extractScreamingSnakeCode(error);
  if (code) {
    const key = `support_err_${code.toLowerCase()}`;
    const label = t(key);
    if (label !== key) return label;
  }
  return t('error_generic');
};

const trimmed = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};
const newId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const nowIso = () => new Date().toISOString();
const sortByCreatedDesc = (rows) => [...rows].sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)));

const TICKET_LIST_COLUMNS = 'id, ticket_no, category, status, priority, subject, requester_name, requester_email, '
  + 'requester_user_id, assigned_to, first_response_on, closed_on, created_on, updated_on';

// A soft client-side cap, same philosophy as support_console()'s own 500-row
// limit (migration 018 §4) — this reads one company's tickets, not every
// tenant's, so a smaller bound is plenty.
const LIST_CAP = 300;

// ---------------------------------------------------------------------------
// Local preview store
// ---------------------------------------------------------------------------
const DEMO_KEY = 'bbnovix_support_demo';
const DEMO_USER_ID = 'demo-user';

const seedDemo = () => {
  const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
  return {
    tickets: [
      {
        id: 'demo-ticket-1', ticket_no: 'BBX-2026-000101', category: 'Technical', status: 'Answered', priority: 'Normal',
        subject: 'Cannot upload my signature', body: 'The signature upload keeps failing on the profile page.',
        requester_name: 'أحمد محمد', requester_email: 'admin@shalfa.local', requester_user_id: DEMO_USER_ID,
        assigned_to: null, first_response_on: daysAgo(1), closed_on: null,
        created_on: daysAgo(2), updated_on: daysAgo(1), is_deleted: false,
      },
      {
        id: 'demo-ticket-2', ticket_no: 'BBX-2026-000102', category: 'Billing', status: 'Open', priority: 'Low',
        subject: 'Question about the invoice', body: 'Could you clarify last month’s invoice line items?',
        requester_name: 'أحمد محمد', requester_email: 'admin@shalfa.local', requester_user_id: DEMO_USER_ID,
        assigned_to: null, first_response_on: null, closed_on: null,
        created_on: daysAgo(1), updated_on: daysAgo(1), is_deleted: false,
      },
      {
        id: 'demo-ticket-3', ticket_no: 'BBX-2026-000098', category: 'Other', status: 'InProgress', priority: 'High',
        subject: 'Approval chain appears stuck', body: 'A leave request has been sitting with the same approver for a week.',
        requester_name: 'سارة العتيبي', requester_email: 'sara@shalfa.local', requester_user_id: 'demo-user-2',
        assigned_to: null, first_response_on: daysAgo(3), closed_on: null,
        created_on: daysAgo(4), updated_on: daysAgo(3), is_deleted: false,
      },
    ],
    messages: [
      {
        id: 'demo-msg-1', ticket_id: 'demo-ticket-1', author_type: 'Requester', author_user_id: DEMO_USER_ID,
        author_name: 'أحمد محمد', body: 'The signature upload keeps failing on the profile page.',
        is_internal: false, created_on: daysAgo(2),
      },
      {
        id: 'demo-msg-2', ticket_id: 'demo-ticket-1', author_type: 'Operator', author_user_id: null,
        author_name: 'Support', body: 'Please try a PNG under 2 MB — we are looking into the underlying limit.',
        is_internal: false, created_on: daysAgo(1),
      },
      {
        id: 'demo-msg-3', ticket_id: 'demo-ticket-2', author_type: 'Requester', author_user_id: DEMO_USER_ID,
        author_name: 'أحمد محمد', body: 'Could you clarify last month’s invoice line items?',
        is_internal: false, created_on: daysAgo(1),
      },
      {
        id: 'demo-msg-4', ticket_id: 'demo-ticket-3', author_type: 'Requester', author_user_id: 'demo-user-2',
        author_name: 'سارة العتيبي', body: 'A leave request has been sitting with the same approver for a week.',
        is_internal: false, created_on: daysAgo(4),
      },
      {
        id: 'demo-msg-5', ticket_id: 'demo-ticket-3', author_type: 'Operator', author_user_id: DEMO_USER_ID,
        author_name: 'أحمد محمد', body: 'Looking into it now, thank you for flagging it.',
        is_internal: false, created_on: daysAgo(3),
      },
    ],
  };
};

const readDemo = () => {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    if (raw) return { ...seedDemo(), ...JSON.parse(raw) };
  } catch {
    // A corrupted preview store is simply reseeded.
  }
  const seeded = seedDemo();
  try { localStorage.setItem(DEMO_KEY, JSON.stringify(seeded)); } catch { /* preview only */ }
  return seeded;
};

const writeDemo = (state) => {
  try { localStorage.setItem(DEMO_KEY, JSON.stringify(state)); } catch { /* preview only */ }
  return state;
};

// Strips `body`/`is_deleted` the same way TICKET_LIST_COLUMNS does for a real
// read, so demo and live rows are shaped identically for the list screens.
const toListRow = ({ body, is_deleted, ...row }) => row; // eslint-disable-line no-unused-vars

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** An employee's own tickets — requester_user_id is always required, never inferred. */
export async function loadMyTickets(requesterUserId) {
  if (!requesterUserId) return ok([]);
  if (useLocalData) {
    const rows = readDemo().tickets
      .filter((row) => row.requester_user_id === requesterUserId && !row.is_deleted)
      .map(toListRow);
    return ok(sortByCreatedDesc(rows));
  }
  return runList(() => supabase
    .from('support_tickets')
    .select(TICKET_LIST_COLUMNS)
    .eq('requester_user_id', requesterUserId)
    .eq('is_deleted', false)
    .order('created_on', { ascending: false })
    .limit(LIST_CAP));
}

/**
 * The company-wide list — RLS alone decides who reaches any rows at all
 * (Support.View/Support.Manage in the caller's own tenant); this file adds
 * no extra scoping beyond the optional filters.
 * @param {{status?: string, category?: string, priority?: string}} filters
 */
export async function loadCompanyTickets(filters = {}) {
  if (useLocalData) {
    let rows = readDemo().tickets.filter((row) => !row.is_deleted);
    if (filters.status) rows = rows.filter((row) => row.status === filters.status);
    if (filters.category) rows = rows.filter((row) => row.category === filters.category);
    if (filters.priority) rows = rows.filter((row) => row.priority === filters.priority);
    return ok(sortByCreatedDesc(rows.map(toListRow)));
  }
  let query = supabase.from('support_tickets').select(TICKET_LIST_COLUMNS).eq('is_deleted', false);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.category) query = query.eq('category', filters.category);
  if (filters.priority) query = query.eq('priority', filters.priority);
  return runList(() => query.order('created_on', { ascending: false }).limit(LIST_CAP));
}

/** One ticket plus its full thread — { ticket, messages }, see this file's own header. */
export async function loadTicketDetail(ticketId) {
  if (!ticketId) return ko('TICKET_ID_REQUIRED');
  if (useLocalData) {
    const ticket = readDemo().tickets.find((row) => row.id === ticketId && !row.is_deleted);
    if (!ticket) return ko('TICKET_NOT_FOUND');
    const messages = readDemo().messages
      .filter((row) => row.ticket_id === ticketId)
      .sort((a, b) => String(a.created_on).localeCompare(String(b.created_on)));
    return ok({ ticket, messages });
  }
  return run(() => supabase.rpc('support_ticket_detail', { p_ticket_id: ticketId }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Raises an in-app ticket via support_ticket_create_internal — see this
 * file's own header for its real Support.Manage gate.
 * @param {{subject: string, body: string, category?: string, priority?: string}} input
 */
export async function createMyTicket(input) {
  if (!trimmed(input?.subject)) return ko('SUBJECT_REQUIRED');
  if (!trimmed(input?.body)) return ko('BODY_REQUIRED');
  const payload = {
    subject: input.subject.trim(),
    body: input.body.trim(),
    category: SUPPORT_TICKET_CATEGORIES.includes(input.category) ? input.category : 'Other',
    priority: SUPPORT_TICKET_PRIORITIES.includes(input.priority) ? input.priority : 'Normal',
  };
  if (useLocalData) {
    const state = readDemo();
    const id = newId();
    const ticketNo = `BBX-${new Date().getFullYear()}-${String(100 + state.tickets.length + 1).padStart(6, '0')}`;
    const ticket = {
      id, ticket_no: ticketNo, category: payload.category, status: 'Open', priority: payload.priority,
      subject: payload.subject, body: payload.body,
      requester_name: 'Demo User', requester_email: 'admin@shalfa.local', requester_user_id: DEMO_USER_ID,
      assigned_to: null, first_response_on: null, closed_on: null,
      created_on: nowIso(), updated_on: nowIso(), is_deleted: false,
    };
    state.tickets = [ticket, ...state.tickets];
    state.messages = [...state.messages, {
      id: newId(), ticket_id: id, author_type: 'Requester', author_user_id: DEMO_USER_ID, author_name: 'Demo User',
      body: payload.body, is_internal: false, created_on: nowIso(),
    }];
    writeDemo(state);
    return ok({ id, ticket_no: ticketNo, status: 'Open' });
  }
  return callRpc('support_ticket_create_internal', { p_payload: payload });
}

/** The requester's own reply, or a Support.Manage holder's — see this file's own header. */
export async function replyToTicket(ticketId, body, isInternal = false) {
  if (!ticketId) return ko('TICKET_ID_REQUIRED');
  if (!trimmed(body)) return ko('BODY_REQUIRED');
  if (useLocalData) {
    const state = readDemo();
    const ticket = state.tickets.find((row) => row.id === ticketId);
    if (!ticket) return ko('TICKET_NOT_FOUND');
    const message = {
      id: newId(), ticket_id: ticketId, author_type: 'Operator', author_user_id: DEMO_USER_ID, author_name: 'Demo User',
      body: body.trim(), is_internal: false, created_on: nowIso(),
    };
    state.messages = [...state.messages, message];
    ticket.status = 'Answered';
    ticket.first_response_on = ticket.first_response_on || nowIso();
    ticket.updated_on = nowIso();
    writeDemo(state);
    return ok({ ticket_id: ticketId, message_id: message.id, status: ticket.status });
  }
  return callRpc('support_reply', { p_ticket_id: ticketId, p_body: body, p_is_internal: !!isInternal });
}

/** Company admin (Support.Manage) or the platform operator — see this file's own header. */
export async function setTicketStatus(ticketId, status) {
  if (!ticketId) return ko('TICKET_ID_REQUIRED');
  if (!SUPPORT_TICKET_STATUSES.includes(status)) return ko('STATUS_INVALID');
  if (useLocalData) {
    const state = readDemo();
    const ticket = state.tickets.find((row) => row.id === ticketId);
    if (!ticket) return ko('TICKET_NOT_FOUND');
    ticket.status = status;
    ticket.closed_on = status === 'Closed' ? nowIso() : null;
    ticket.updated_on = nowIso();
    writeDemo(state);
    return ok({ ticket_id: ticketId, status });
  }
  return callRpc('support_ticket_set_status', { p_ticket_id: ticketId, p_status: status });
}

/**
 * support_ticket_assign() is is_platform_operator()-only — see this file's
 * own header for why no company screen wires a control to this. Exported for
 * completeness and for a future operator-facing screen to reuse.
 */
export async function assignTicket(ticketId, userId) {
  if (!ticketId) return ko('TICKET_ID_REQUIRED');
  if (useLocalData) {
    const state = readDemo();
    const ticket = state.tickets.find((row) => row.id === ticketId);
    if (!ticket) return ko('TICKET_NOT_FOUND');
    ticket.assigned_to = userId || null;
    writeDemo(state);
    return ok({ ticket_id: ticketId, assigned_to: userId || null });
  }
  return callRpc('support_ticket_assign', { p_ticket_id: ticketId, p_user_id: userId || null });
}
