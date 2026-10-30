
// ================= Data layer (Firestore is the source of truth) =================
// Balances are never stored. They are calculated from transactions, so creating, editing,
// deleting, or transferring a transaction updates every balance automatically.
// Money is summed in integer cents to avoid floating-point drift.

const CURRENCIES = ["IQD", "USD", "EUR", "TRY", "GBP"];
const RECORD_COLLECTIONS = ["accounts", "transactions", "budgets", "debts", "cards", "savings"];
const state = { accounts: [], transactions: [], budgets: [], debts: [], cards: [], savings: [] };
const loaded = {};
const syncFlags = {};
const unsubscribers = [];
let uid = null;

const userCol = name => collection(db, "users", uid, name);
const userDoc = (name, id) => doc(db, "users", uid, name, id);

const numberFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const cents = n => Math.round((Number(n) || 0) * 100);
const fmt = n => numberFormat.format(Math.round(Number(n) * 100) / 100);
const fmtC = c => fmt(c / 100);
const pad2 = n => String(n).padStart(2, "0");
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const todayYM = () => todayStr().slice(0, 7);
const norm = s => String(s || "").trim().toLowerCase();
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const SPACE_LABEL = { personal: "Personal", family: "Family", business: "Business", all: "All spaces" };
const TYPE_LABEL = { income: "Income", expense: "Expense", transfer: "Transfer" };
const ACCOUNT_TYPE_LABEL = { cash: "Cash", bank: "Bank", other: "Other" };
const DIRECTION_LABEL = { owe: "I owe", owed: "Owed to me" };
const KIND_COLLECTION = { account: "accounts", card: "cards", savings: "savings", debt: "debts" };

// Small DOM builder: text is always inserted as text, never as HTML.
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function emptyBlock(title, text) {
  return h("div", { class: "empty" }, h("h4", { text: title }), h("p", { class: "small", text }));
}

function parseRef(value) {
  const [kind, id] = String(value || "").split(":");
  return { kind: kind || "", id: id || "" };
}

function entity(kind, id) {
  return (state[KIND_COLLECTION[kind]] || []).find(x => x.id === id) || null;
}

function entityName(kind, id) {
  if (kind === "external") return "External";
  const e = entity(kind, id);
  if (!e) return "(deleted)";
  return kind === "debt" ? `${e.name} (${DIRECTION_LABEL[e.direction] || "debt"})` : e.name;
}

function entityCurrency(kind, id) {
  const e = entity(kind, id);
  return e ? e.currency : "IQD";
}

function curOfRef(r) {
  return r.kind && r.id ? entityCurrency(r.kind, r.id) : "IQD";
}

// True when any transaction uses this entity. Such entities cannot be deleted or change currency.
function isReferenced(kind, id) {
  return state.transactions.some(t =>
    (t.fromKind === kind && t.fromId === id) || (t.toKind === kind && t.toId === id));
}

// Balance in cents for every account, card (amount owed), savings goal, and debt (remaining).
// Rules: money leaving an account or goal reduces it; money arriving increases it.
// A card purchase increases what is owed; a repayment reduces it. A debt payment or collection reduces what remains.
function computeBalances() {
  const bal = {};
  const key = (kind, id) => `${kind}:${id}`;
  for (const a of state.accounts) bal[key("account", a.id)] = cents(a.openingBalance);
  for (const c of state.cards) bal[key("card", c.id)] = cents(c.openingBalance);
  for (const s of state.savings) bal[key("savings", s.id)] = cents(s.openingBalance);
  for (const d of state.debts) bal[key("debt", d.id)] = cents(d.originalAmount);
  for (const t of state.transactions) {
    const amount = cents(t.amount);
    const received = cents(t.toAmount);
    if (t.fromKind !== "external") {
      const k = key(t.fromKind, t.fromId);
      bal[k] = (bal[k] || 0) + (t.fromKind === "card" ? amount : -amount);
    }
    if (t.toKind !== "external") {
      const k = key(t.toKind, t.toId);
      bal[k] = (bal[k] || 0) + (t.toKind === "card" || t.toKind === "debt" ? -received : received);
    }
  }
  return bal;
}

function balanceOf(bal, kind, id) {
  return bal[`${kind}:${id}`] || 0;
}

// Income and expenses for a month, in IQD cents, using each entry's saved rate.
// Transfers are never counted, so repayments and savings moves are not double-counted.
function monthTotals(ym = todayYM()) {
  const bySpace = { personal: { income: 0, expense: 0 }, family: { income: 0, expense: 0 }, business: { income: 0, expense: 0 } };
  let income = 0;
  let expense = 0;
  for (const t of state.transactions) {
    if (!t.date || t.date.slice(0, 7) !== ym || !bySpace[t.space]) continue;
    const iqd = cents(t.amountIQD);
    if (t.type === "income") { income += iqd; bySpace[t.space].income += iqd; }
    else if (t.type === "expense") { expense += iqd; bySpace[t.space].expense += iqd; }
  }
  return { income, expense, net: income - expense, bySpace };
}

function budgetSpent(budget, ym = todayYM()) {
  let spent = 0;
  for (const t of state.transactions) {
    if (t.type !== "expense" || t.date.slice(0, 7) !== ym) continue;
    if (budget.space !== "all" && t.space !== budget.space) continue;
    if (budget.scope === "category" && norm(t.category) !== norm(budget.category)) continue;
    spent += cents(t.amountIQD);
  }
  return spent;
}

function budgetName(b) {
  const scope = b.scope === "overall" ? "Overall limit" : b.category;
  return `${scope} · ${SPACE_LABEL[b.space]}`;
}

// ----- Live data: one listener per collection. Firestore keeps a local copy for offline use. -----
function startDataForUser(userId) {
  uid = userId;
  ensureUserDocuments();
  for (const name of RECORD_COLLECTIONS) {
    const q = name === "transactions" ? query(userCol(name), orderBy("date", "desc")) : userCol(name);
    unsubscribers.push(onSnapshot(q, { includeMetadataChanges: true }, snap => {
      state[name] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      syncFlags[name] = { pending: snap.metadata.hasPendingWrites, fromCache: snap.metadata.fromCache };
      loaded[name] = true;
      refreshAll();
    }, err => handleListenError(name, err)));
  }
}

// Creates the owner's root document and settings once. Rules only allow these exact shapes.
async function ensureUserDocuments() {
  try {
    const root = doc(db, "users", uid);
    if (!(await getDoc(root)).exists()) {
      await setDoc(root, { uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    }
    const prefs = userDoc("settings", "prefs");
    if (!(await getDoc(prefs)).exists()) {
      await setDoc(prefs, { uid, language: "en", primaryCurrency: "IQD", createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    }
  } catch (err) {
    console.warn("Account setup not complete yet:", err && err.code);
  }
}

function handleListenError(name, err) {
  console.warn("Data listener error:", name, err && err.code);
  if (err && err.code === "permission-denied") {
    setOverviewNotice("Access denied. This account is not authorized to view these records.", true);
    toast("Access denied. This account is not authorized for these records.");
  } else {
    setOverviewNotice("Connection problem. Showing the last saved records on this device.", true);
  }
}

function stopListeners() {
  while (unsubscribers.length) {
    try { unsubscribers.pop()(); } catch (err) { /* listener already closed */ }
  }
}

function hasUnsyncedChanges() {
  return Object.values(syncFlags).some(f => f && f.pending);
}

function updateSyncStatus() {
  const el = $("syncStatus");
  if (!el) return;
  if (!navigator.onLine) {
    el.textContent = "Offline. Changes are saved on this device and will sync when you reconnect.";
    el.className = "tag amber";
  } else if (hasUnsyncedChanges()) {
    el.textContent = "Syncing changes to your account…";
    el.className = "tag amber";
  } else if (RECORD_COLLECTIONS.every(n => loaded[n])) {
    el.textContent = "All changes are saved to your account.";
    el.className = "tag green";
  } else {
    el.textContent = "Connecting…";
    el.className = "tag";
  }
}

// ----- Writes -----
// Changes appear at once (Firestore applies them locally first). If the server rejects a change,
// Firestore rolls the local copy back and we show a message.
function writeRecord(collectionName, id, data, errorId, onDone) {
  if (!uid) {
    showFormError(errorId, "You are not signed in.");
    return;
  }
  const ref = id ? userDoc(collectionName, id) : doc(userCol(collectionName));
  const body = id
    ? { ...data, updatedAt: serverTimestamp() }
    : { ...data, uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  const operation = id ? updateDoc(ref, body) : setDoc(ref, body);
  operation.catch(err => {
    console.warn("Write rejected:", collectionName, err && err.code);
    toast(writeErrorMessage(err));
  });
  if (onDone) onDone(ref.id);
}

function removeRecord(collectionName, id, label) {
  if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
  deleteDoc(userDoc(collectionName, id)).catch(err => {
    console.warn("Delete rejected:", collectionName, err && err.code);
    toast(writeErrorMessage(err));
  });
}

function writeErrorMessage(err) {
  if (err && err.code === "permission-denied") return "The server did not accept this change. Check the entry and try again.";
  return "The change could not be saved. Please try again.";
}

let toastTimer = null;
function toast(message, ok = false) {
  let el = $("toast");
  if (!el) {
    el = h("div", { id: "toast", role: "status" });
    document.body.append(el);
  }
  el.textContent = message;
  el.className = ok ? "ok" : "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 5000);
}

function showFormError(id, text) {
  const el = $(id);
  el.textContent = text;
  el.classList.remove("hidden");
}

function clearFormError(id) {
  const el = $(id);
  el.textContent = "";
  el.classList.add("hidden");
}

function setOverviewNotice(text, warn = false) {
  const el = $("overviewNotice");
  if (!el) return;
  el.textContent = text;
  el.className = warn ? "auth-message error" : "notice";
}

function openCard(id) {
  const el = $(id);
  el.classList.remove("hidden");
  el.scrollIntoView({ behavior: "smooth", block: "center" });
}

function closeCard(id) {
  $(id).classList.add("hidden");
}

// ================= Rendering =================
function refreshAll() {
  if (!uid) return;
  renderSelectors();
  renderOverview();
  renderTransactions();
  renderAccounts();
  renderBudgets();
  renderCards();
  renderDebts();
  renderSavings();
  updateSyncStatus();
}

function renderSelectors() {
  const categories = [...new Set([...state.transactions.map(t => t.category), ...state.budgets.map(b => b.category)].filter(Boolean))].sort();
  $("categoryList").replaceChildren(...categories.map(c => h("option", { value: c })));
  buildTxOptions();
}

function setStat(id, valueCents, currency = "IQD") {
  $(id).replaceChildren(fmtC(valueCents), " ", h("small", { text: currency }));
}

function renderOverview() {
  const bal = computeBalances();
  const iqdAccounts = state.accounts.filter(a => a.currency === "IQD");
  const total = iqdAccounts.reduce((sum, a) => sum + balanceOf(bal, "account", a.id), 0);
  setStat("ovTotal", total);
  $("ovTotalNote").textContent = `Across ${iqdAccounts.length} IQD account(s). Other currencies are shown on Accounts.`;

  const m = monthTotals();
  setStat("ovIncome", m.income);
  setStat("ovExpense", m.expense);
  setStat("ovNet", m.net);
  for (const sp of ["personal", "family", "business"]) {
    const net = m.bySpace[sp].income - m.bySpace[sp].expense;
    $("space" + cap(sp)).replaceChildren(fmtC(net), " IQD");
  }

  const max = Math.max(m.income, m.expense, 1);
  $("ovBars").replaceChildren(
    barRow("Income", m.income, max, ""),
    barRow("Expenses", m.expense, max, "warn")
  );

  const recent = state.transactions.slice(0, 5);
  $("ovRecent").replaceChildren(...(recent.length
    ? recent.map(t => compactTxRow(t))
    : [emptyBlock("No transactions yet", "Income, expenses, and transfers will appear here.")]));

  const obligations = [
    ...state.debts.filter(d => d.direction === "owe" && balanceOf(bal, "debt", d.id) > 0 && d.dueDate)
      .map(d => ({ date: d.dueDate, text: `${d.name}: ${fmtC(balanceOf(bal, "debt", d.id))} ${d.currency}` })),
    ...state.cards.filter(c => balanceOf(bal, "card", c.id) > 0)
      .map(c => ({ date: `day ${c.dueDay}`, text: `${c.name} card payment: ${fmtC(balanceOf(bal, "card", c.id))} ${c.currency}` }))
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  $("ovObligations").replaceChildren(...(obligations.length
    ? obligations.slice(0, 6).map(o => h("div", { class: "rec-row" }, h("div", { class: "rec-main", text: o.text }), h("div", { class: "rec-amount muted small", text: o.date })))
    : [h("p", { class: "muted small", text: "No upcoming card payments or debt due dates." })]));

  $("ovBudgetTag").textContent = `${state.budgets.length} active`;
  const overall = state.budgets.find(b => b.scope === "overall" && b.space === "all");
  $("ovBudgetNote").textContent = overall
    ? `Overall limit: ${fmtC(budgetSpent(overall))} of ${fmt(overall.limit)} IQD used this month.`
    : "Monthly limits and category spending.";

  const saved = state.savings.filter(s => s.currency === "IQD").reduce((sum, s) => sum + balanceOf(bal, "savings", s.id), 0);
  $("ovGoals").textContent = state.savings.length
    ? `${state.savings.length} goal(s). ${fmtC(saved)} IQD saved in IQD goals.`
    : "Track targets and contributions.";

  const allLoaded = RECORD_COLLECTIONS.every(n => loaded[n]);
  if (allLoaded) {
    const empty = !state.accounts.length && !state.transactions.length;
    setOverviewNotice(empty
      ? "No records yet. Start by adding your accounts and their opening balances on the Accounts page."
      : "Showing your saved records. Balances are calculated from your transactions.");
  }
}

function barRow(label, value, max, cls) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  const bar = h("div", { class: `progress ${cls}` }, h("span"));
  bar.firstChild.style.width = `${pct}%`;
  return h("div", { class: "rec-row", style: "margin-bottom:8px" },
    h("div", { class: "rec-main", text: label }),
    h("div", { class: "rec-amount" }, `${fmtC(value)} IQD`, bar));
}

function compactTxRow(t) {
  const sign = t.type === "income" ? "+" : t.type === "expense" ? "−" : "";
  const cls = t.type === "income" ? "positive" : t.type === "expense" ? "negative" : "muted";
  return h("div", { class: "rec-row" },
    h("div", { class: "rec-main" }, h("strong", { text: t.description || TYPE_LABEL[t.type] }), h("div", { class: "sub", text: `${t.date} · ${TYPE_LABEL[t.type]}` })),
    h("div", { class: `rec-amount ${cls}`, text: `${sign}${fmt(t.amount)} ${t.currency}` }));
}

function txAccountLabel(t) {
  if (t.type === "transfer") return `${entityName(t.fromKind, t.fromId)} → ${entityName(t.toKind, t.toId)}`;
  if (t.type === "income") return entityName(t.toKind, t.toId);
  return entityName(t.fromKind, t.fromId);
}

function renderTransactions() {
  const q = norm($("txSearch").value);
  const ft = $("txFilterType").value;
  const fs = $("txFilterSpace").value;
  const fc = $("txFilterCurrency").value;
  const rows = state.transactions.filter(t => {
    if (ft !== "all" && t.type !== ft) return false;
    if (fs !== "all" && t.space !== fs) return false;
    if (fc !== "all" && t.currency !== fc) return false;
    if (q) {
      const text = norm([t.description, t.category, t.date, txAccountLabel(t)].join(" "));
      if (!text.includes(q)) return false;
    }
    return true;
  });
  const tbody = $("txTableBody");
  if (!rows.length) {
    tbody.replaceChildren(h("tr", null, h("td", {
      colspan: "7", class: "muted",
      style: "text-align:center;padding:35px",
      text: state.transactions.length ? "No transactions match these filters." : "No transactions recorded yet. Add your first one."
    })));
    return;
  }
  tbody.replaceChildren(...rows.map(txTableRow));
}

function txTableRow(t) {
  const sign = t.type === "income" ? "+" : t.type === "expense" ? "−" : "";
  const cls = t.type === "income" ? "positive" : t.type === "expense" ? "negative" : "muted";
  const amountText = t.type === "transfer" && t.toCurrency !== t.currency
    ? `${fmt(t.amount)} ${t.currency} → ${fmt(t.toAmount)} ${t.toCurrency}`
    : `${sign}${fmt(t.amount)} ${t.currency}`;
  const iqdNote = t.currency !== "IQD" ? `≈ ${fmt(t.amountIQD)} IQD at saved rate ${fmt(t.fxRateToIQD)}` : "";
  return h("tr", null,
    h("td", { text: t.date }),
    h("td", { text: t.description || TYPE_LABEL[t.type] }),
    h("td", { text: t.category || "—" }),
    h("td", { text: SPACE_LABEL[t.space] }),
    h("td", { text: txAccountLabel(t) }),
    h("td", { class: `amount ${cls}` }, amountText, iqdNote ? h("div", { class: "muted small", text: iqdNote }) : null),
    h("td", { class: "table-actions" },
      h("button", { class: "btn small", type: "button", onclick: () => editTransaction(t.id) }, "Edit"), " ",
      h("button", { class: "btn small", type: "button", onclick: () => deleteTransaction(t.id) }, "Delete")));
}

function renderAccounts() {
  const bal = computeBalances();
  const cashIqd = state.accounts.filter(a => a.type === "cash" && a.currency === "IQD");
  const iqdAll = state.accounts.filter(a => a.currency === "IQD");
  setStat("cashTotal", cashIqd.reduce((s, a) => s + balanceOf(bal, "account", a.id), 0));
  $("cashNote").textContent = cashIqd.length ? `${cashIqd.length} IQD cash account(s)` : "No IQD cash accounts yet";
  $("bankCount").textContent = String(state.accounts.filter(a => a.type === "bank").length);
  setStat("combinedTotal", iqdAll.reduce((s, a) => s + balanceOf(bal, "account", a.id), 0));
  $("combinedNote").textContent = "IQD accounts only until exchange rates are connected";

  $("accountList").replaceChildren(...(state.accounts.length
    ? state.accounts.map(a => h("div", { class: "rec-row" },
      h("div", { class: "rec-main" }, h("strong", { text: a.name }), h("div", { class: "sub", text: `${ACCOUNT_TYPE_LABEL[a.type] || a.type} · ${a.currency}` })),
      h("div", { class: "rec-amount", text: `${fmtC(balanceOf(bal, "account", a.id))} ${a.currency}` }),
      h("div", { class: "rec-actions" },
        h("button", { class: "btn small", type: "button", onclick: () => editAccount(a.id) }, "Edit"),
        h("button", { class: "btn small", type: "button", onclick: () => deleteAccount(a.id) }, "Delete"))))
    : [emptyBlock("No accounts yet", "Add cash, bank, or other accounts.")]));
}

function renderBudgets() {
  const overall = state.budgets.find(b => b.scope === "overall" && b.space === "all");
  if (overall) {
    const spent = budgetSpent(overall);
    $("budgetOverallValue").replaceChildren(fmtC(spent), " / ", fmt(overall.limit), " ", h("small", { text: "IQD" }));
    setProgress("budgetOverallBar", spent, cents(overall.limit));
    $("budgetOverallNote").textContent = spent > cents(overall.limit) ? "Over the monthly limit." : "Spent this month, counting expenses and card purchases.";
  } else {
    $("budgetOverallValue").replaceChildren("— ", h("small", { text: "IQD" }));
    setProgress("budgetOverallBar", 0, 1);
    $("budgetOverallNote").textContent = "No overall budget configured";
  }
  $("budgetCategoryCount").textContent = String(state.budgets.filter(b => b.scope === "category").length);
  $("budgetList").replaceChildren(...(state.budgets.length
    ? state.budgets.map(b => {
      const spent = budgetSpent(b);
      const limit = cents(b.limit);
      const remaining = limit - spent;
      const pct = limit ? spent / limit : 0;
      const tone = pct > 1 ? "bad" : pct >= 0.8 ? "warn" : "ok";
      const status = pct > 1 ? "Exceeded" : pct >= 0.8 ? "Near limit" : "On track";
      return h("div", { class: "rec-row", style: "display:block" },
        h("div", { style: "display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap" },
          h("strong", { text: budgetName(b) }),
          h("span", { class: `pill ${tone}`, text: status })),
        h("div", { class: "sub", text: `${fmtC(spent)} of ${fmt(b.limit)} IQD · remaining ${fmtC(remaining)} IQD` }),
        h("div", { class: `progress ${pct > 1 ? "over" : pct >= 0.8 ? "warn" : ""}` },
          h("span", { style: `width:${Math.min(100, pct * 100).toFixed(1)}%` })),
        h("div", { class: "rec-actions", style: "margin-top:8px" },
          h("button", { class: "btn small", type: "button", onclick: () => editBudget(b.id) }, "Edit"),
          h("button", { class: "btn small", type: "button", onclick: () => deleteBudget(b.id) }, "Delete")));
    })
    : [emptyBlock("No budgets yet", "Set an overall monthly limit or a category limit.")]));
}

function setProgress(id, value, max) {
  const bar = $(id);
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  bar.className = `progress ${value > max ? "over" : pct >= 80 ? "warn" : ""}`;
  bar.firstElementChild.style.width = `${pct}%`;
}

function renderCards() {
  const bal = computeBalances();
  const iqdCards = state.cards.filter(c => c.currency === "IQD");
  const owed = iqdCards.reduce((s, c) => s + balanceOf(bal, "card", c.id), 0);
  const limit = iqdCards.reduce((s, c) => s + cents(c.creditLimit), 0);
  setStat("cardOutstanding", owed);
  setStat("cardAvailable", limit - owed);
  $("cardCount").textContent = String(state.cards.length);
  $("cardList").replaceChildren(...(state.cards.length
    ? state.cards.map(c => {
      const owedNow = balanceOf(bal, "card", c.id);
      return h("div", { class: "rec-row" },
        h("div", { class: "rec-main" }, h("strong", { text: c.name }),
          h("div", { class: "sub", text: `Limit ${fmt(c.creditLimit)} ${c.currency} · available ${fmtC(cents(c.creditLimit) - owedNow)} ${c.currency}` }),
          h("div", { class: "sub", text: `Statement day ${c.statementDay} · due day ${c.dueDay}` })),
        h("div", { class: `rec-amount ${owedNow > 0 ? "negative" : ""}`, text: `${fmtC(owedNow)} ${c.currency} owed` }),
        h("div", { class: "rec-actions" },
          h("button", { class: "btn small", type: "button", onclick: () => editCard(c.id) }, "Edit"),
          h("button", { class: "btn small", type: "button", onclick: () => deleteCard(c.id) }, "Delete")));
    })
    : [emptyBlock("No credit cards added", "Add a card to track its limit, balance owed, and due dates.")]));
}

function renderDebts() {
  const bal = computeBalances();
  const owe = state.debts.filter(d => d.direction === "owe" && d.currency === "IQD").reduce((s, d) => s + balanceOf(bal, "debt", d.id), 0);
  const owed = state.debts.filter(d => d.direction === "owed" && d.currency === "IQD").reduce((s, d) => s + balanceOf(bal, "debt", d.id), 0);
  setStat("debtOwe", owe);
  setStat("debtOwed", owed);
  $("debtList").replaceChildren(...(state.debts.length
    ? state.debts.map(d => {
      const remaining = balanceOf(bal, "debt", d.id);
      return h("div", { class: "rec-row" },
        h("div", { class: "rec-main" }, h("strong", { text: d.name }),
          h("div", { class: "sub", text: `${DIRECTION_LABEL[d.direction]} · original ${fmt(d.originalAmount)} ${d.currency}${d.dueDate ? " · due " + d.dueDate : ""}` }),
          d.notes ? h("div", { class: "sub", text: d.notes }) : null),
        h("div", { class: `rec-amount ${d.direction === "owe" ? "negative" : "positive"}` }, `${fmtC(remaining)} ${d.currency}`, h("div", { class: "sub", text: "remaining" })),
        h("div", { class: "rec-actions" },
          h("button", { class: "btn small", type: "button", onclick: () => editDebt(d.id) }, "Edit"),
          h("button", { class: "btn small", type: "button", onclick: () => deleteDebt(d.id) }, "Delete")));
    })
    : [emptyBlock("No debts or loans recorded", "Track people, original amounts, due dates, repayments, and remaining balances.")]));
}

function renderSavings() {
  const bal = computeBalances();
  const iqdGoals = state.savings.filter(s => s.currency === "IQD");
  setStat("goalSaved", iqdGoals.reduce((s, g) => s + balanceOf(bal, "savings", g.id), 0));
  $("goalCount").textContent = String(state.savings.length);
  $("goalList").replaceChildren(...(state.savings.length
    ? state.savings.map(g => {
      const saved = balanceOf(bal, "savings", g.id);
      const target = cents(g.targetAmount);
      const pct = target ? Math.min(100, (saved / target) * 100) : 0;
      return h("div", { class: "rec-row", style: "display:block" },
        h("div", { style: "display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap" },
          h("strong", { text: g.name }),
          h("span", { class: "muted small", text: `${Math.round(pct)}%` })),
        h("div", { class: "sub", text: `${fmtC(saved)} of ${fmt(g.targetAmount)} ${g.currency}${g.targetDate ? " · target " + g.targetDate : ""}` }),
        h("div", { class: "progress" }, h("span", { style: `width:${pct}%` })),
        h("div", { class: "rec-actions", style: "margin-top:8px" },
          h("button", { class: "btn small", type: "button", onclick: () => editGoal(g.id) }, "Edit"),
          h("button", { class: "btn small", type: "button", onclick: () => deleteGoal(g.id) }, "Delete")));
    })
    : [emptyBlock("No savings goals yet", "Create a goal with a target amount and an optional target date.")]));
}
