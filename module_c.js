
// ================= Forms and actions =================
const editing = { tx: null, account: null, card: null, debt: null, goal: null, budget: null };
const numOrNaN = v => (String(v).trim() === "" ? NaN : Number(v));
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v);
const isDay = v => Number.isInteger(v) && v >= 1 && v <= 31;
const txEls = {
  type: $("txType"), amount: $("txAmount"), currency: $("txCurrency"), date: $("txDate"),
  space: $("txSpace"), category: $("txCategory"), from: $("txFrom"), to: $("txTo"),
  toAmount: $("txToAmount"), rate: $("txRate"), payment: $("txPayment"), desc: $("txDesc")
};

function entityLabel(kind, e, bal) {
  const amount = fmtC(balanceOf(bal, kind, e.id));
  if (kind === "account") return `${e.name} · ${e.currency} · balance ${amount}`;
  if (kind === "card") return `${e.name} card · ${e.currency} · owed ${amount}`;
  if (kind === "savings") return `${e.name} goal · ${e.currency} · saved ${amount}`;
  return `${e.name} · ${e.currency} · remaining ${amount}`;
}

function listEntities(kind, pred = () => true) {
  const bal = computeBalances();
  return state[KIND_COLLECTION[kind]].filter(pred).map(e => ({
    value: `${kind}:${e.id}`, label: entityLabel(kind, e, bal), id: e.id
  }));
}

// Replaces a select's options. Keeps the previous choice when it is still offered.
function fillSelect(select, options, keepValue) {
  const prev = keepValue ?? select.value;
  select.replaceChildren(...options.map(o => h("option", { value: o.value }, o.label)));
  if (prev && options.some(o => o.value === prev)) select.value = prev;
}

// Only offers choices the rules will accept:
//  income: outside -> account; expense: account/card -> outside;
//  transfer: account|savings|owed-debt -> account|savings|card|owing-debt (card only from an account).
function buildTxOptions(keep = {}) {
  const type = txEls.type.value;
  const accounts = listEntities("account");
  const cards = listEntities("card");
  const savings = listEntities("savings");
  const owedDebts = listEntities("debt", d => d.direction === "owed");
  const owingDebts = listEntities("debt", d => d.direction === "owe");

  let fromOpts;
  if (type === "income") fromOpts = [{ value: "external:", label: "Outside source" }];
  else if (type === "expense") fromOpts = [...accounts, ...cards];
  else fromOpts = [...accounts, ...savings, ...owedDebts];
  fillSelect(txEls.from, fromOpts, keep.from);

  const from = parseRef(txEls.from.value);
  let toOpts;
  if (type === "income") toOpts = accounts;
  else if (type === "expense") toOpts = [{ value: "external:", label: "Outside (expense)" }];
  else if (from.kind === "account") toOpts = [...accounts.filter(a => a.value !== txEls.from.value), ...savings, ...cards, ...owingDebts];
  else if (from.kind === "savings" || from.kind === "debt") toOpts = accounts;
  else toOpts = [];
  fillSelect(txEls.to, toOpts, keep.to);
}

// Looks up the record behind a parsed "kind:id" reference (null for "external:" or missing).
function entityOf(ref) {
  return ref && ref.kind && ref.id ? entity(ref.kind, ref.id) : null;
}

// Shows/hides fields for the chosen type and sets the currency from the chosen account or card.
function updateTxFormUI() {
  const type = txEls.type.value;
  const from = parseRef(txEls.from.value);
  const to = parseRef(txEls.to.value);
  const fromEnt = entityOf(from);
  const toEnt = entityOf(to);

  $("txFromGroup").classList.toggle("hidden", type === "income");
  $("txToGroup").classList.toggle("hidden", type === "expense");
  $("txFromLabel").textContent = type === "expense" ? "Paid from" : "From";
  $("txToLabel").textContent = type === "income" ? "Received into" : "To";

  const currency = type === "income" ? toEnt?.currency : fromEnt?.currency;
  if (currency) {
    txEls.currency.value = currency;
    txEls.currency.disabled = true;
  } else {
    txEls.currency.disabled = false;
  }
  const cur = txEls.currency.value;
  const toCurrency = type === "transfer" ? toEnt?.currency : cur;
  const crossCurrency = type === "transfer" && toCurrency && toCurrency !== cur;

  $("txToAmountGroup").classList.toggle("hidden", !crossCurrency);
  $("txToAmountLabel").textContent = crossCurrency ? `Amount received (${toCurrency})` : "Amount received";
  $("txRateGroup").classList.toggle("hidden", cur === "IQD");
  $("txRateLabel").textContent = `Exchange rate used (IQD per 1 ${cur})`;
}

function openNewTx() {
  resetTxForm();
  $("txFormTitle").textContent = "New transaction";
  $("txSubmit").textContent = "Save transaction";
  txEls.date.value = todayStr();
  buildTxOptions();
  updateTxFormUI();
  openCard("txForm");
}

function resetTxForm() {
  editing.tx = null;
  $("transactionForm").reset();
  txEls.currency.disabled = false;
  clearFormError("txError");
}

function closeTxForm() {
  resetTxForm();
  closeCard("txForm");
}

function editTransaction(id) {
  const t = state.transactions.find(x => x.id === id);
  if (!t) return;
  resetTxForm();
  editing.tx = id;
  $("txFormTitle").textContent = "Edit transaction";
  $("txSubmit").textContent = "Save changes";
  txEls.type.value = t.type;
  txEls.amount.value = t.amount;
  txEls.date.value = t.date;
  txEls.space.value = t.space;
  txEls.category.value = t.category || "";
  txEls.payment.value = t.paymentMethod;
  txEls.desc.value = t.description || "";
  txEls.rate.value = t.currency === "IQD" ? "" : t.fxRateToIQD;
  txEls.toAmount.value = t.toCurrency !== t.currency ? t.toAmount : "";
  buildTxOptions({ from: `${t.fromKind}:${t.fromId}`, to: `${t.toKind}:${t.toId}` });
  updateTxFormUI();
  openCard("txForm");
}

function deleteTransaction(id) {
  removeRecord("transactions", id, "this transaction");
}

function saveTransaction(e) {
  e.preventDefault();
  clearFormError("txError");
  const fail = msg => showFormError("txError", msg);
  const type = txEls.type.value;
  const from = parseRef(txEls.from.value);
  const to = parseRef(txEls.to.value);
  const fromEnt = entityOf(from);
  const toEnt = entityOf(to);
  const amount = numOrNaN(txEls.amount.value);
  const date = txEls.date.value;
  const desc = txEls.desc.value.trim();

  if (type === "income" && !toEnt) return fail("Choose the account that receives the income.");
  if (type === "expense" && !(fromEnt && (from.kind === "account" || from.kind === "card"))) return fail("Choose the account or card you paid from.");
  if (type === "transfer" && !fromEnt) return fail("Choose where the money comes from.");
  if (type === "transfer" && !toEnt) return fail("Choose where the money goes.");
  if (type === "transfer" && from.kind === to.kind && from.id === to.id) return fail("A transfer needs two different places.");
  if (type === "transfer" && to.kind === "card" && from.kind !== "account") return fail("Card repayments must come from an account.");
  if (type === "transfer" && from.kind === "debt" && fromEnt.direction !== "owed") return fail("Only money owed to you can be collected from a debt.");
  if (type === "transfer" && to.kind === "debt" && toEnt.direction !== "owe") return fail("Payments can only go to debts you owe.");
  if (!isDate(date)) return fail("Choose a valid date.");
  if (!(amount > 0)) return fail("Enter an amount greater than zero.");

  const currency = type === "income" ? toEnt.currency : fromEnt.currency;
  const toCurrency = type === "transfer" ? toEnt.currency : currency;
  let toAmount = amount;
  if (toCurrency !== currency) {
    toAmount = numOrNaN(txEls.toAmount.value);
    if (!(toAmount > 0)) return fail(`Enter the amount received in ${toCurrency}.`);
  }
  let rate = 1;
  if (currency !== "IQD") {
    rate = numOrNaN(txEls.rate.value);
    if (!(rate > 0)) return fail(`Enter the exchange rate used for ${currency} (IQD per 1 ${currency}). It is saved with this entry and never changes later.`);
  }
  const amountIQD = Math.round(amount * rate * 100) / 100;

  const data = {
    type,
    date,
    amount,
    currency,
    toAmount,
    toCurrency,
    fromKind: type === "income" ? "external" : from.kind,
    fromId: type === "income" ? "" : from.id,
    toKind: type === "expense" ? "external" : to.kind,
    toId: type === "expense" ? "" : to.id,
    space: txEls.space.value,
    category: txEls.category.value.trim().slice(0, 60),
    paymentMethod: txEls.payment.value,
    description: desc.slice(0, 500),
    fxRateToIQD: rate,
    amountIQD
  };
  writeRecord("transactions", editing.tx, data, "txError");
  toast(navigator.onLine ? "Transaction saved." : "Saved on this device. It will sync when you reconnect.", true);
  closeTxForm();
}

// ----- Accounts -----
function openAccountForm(id) {
  const a = id ? entity("account", id) : null;
  $("accountForm").reset();
  editing.account = a ? a.id : null;
  $("accountFormTitle").textContent = a ? "Edit account" : "New account";
  $("accountSubmit").textContent = a ? "Save changes" : "Save account";
  $("accName").value = a ? a.name : "";
  $("accType").value = a ? a.type : "cash";
  $("accCurrency").value = a ? a.currency : "IQD";
  $("accCurrency").disabled = !!a && isReferenced("account", a.id);
  $("accOpening").value = a ? a.openingBalance : "";
  clearFormError("accountError");
  openCard("accountFormCard");
}

function saveAccount(e) {
  e.preventDefault();
  clearFormError("accountError");
  const name = $("accName").value.trim();
  const opening = numOrNaN($("accOpening").value);
  if (!name) return showFormError("accountError", "Enter an account name.");
  if (Number.isNaN(opening)) return showFormError("accountError", "Enter the opening balance (use 0 if none).");
  writeRecord("accounts", editing.account, {
    name: name.slice(0, 80),
    type: $("accType").value,
    currency: $("accCurrency").value,
    openingBalance: opening
  }, "accountError");
  editing.account = null;
  closeCard("accountFormCard");
}

function deleteAccount(id) {
  const a = entity("account", id);
  if (!a) return;
  if (isReferenced("account", id)) return toast("This account is used by transactions. Delete or edit those transactions first.");
  removeRecord("accounts", id, `account "${a.name}"`);
}

// ----- Credit cards -----
function openCardForm(id) {
  const c = id ? entity("card", id) : null;
  $("cardForm").reset();
  editing.card = c ? c.id : null;
  $("cardFormTitle").textContent = c ? "Edit credit card" : "New credit card";
  $("cardSubmit").textContent = c ? "Save changes" : "Save card";
  $("cardName").value = c ? c.name : "";
  $("cardCurrency").value = c ? c.currency : "IQD";
  $("cardCurrency").disabled = !!c && isReferenced("card", c.id);
  $("cardLimit").value = c ? c.creditLimit : "";
  $("cardOpening").value = c ? c.openingBalance : "";
  $("cardStatement").value = c ? c.statementDay : "";
  $("cardDue").value = c ? c.dueDay : "";
  clearFormError("cardError");
  openCard("cardFormCard");
}

function saveCard(e) {
  e.preventDefault();
  clearFormError("cardError");
  const name = $("cardName").value.trim();
  const limit = numOrNaN($("cardLimit").value);
  const opening = numOrNaN($("cardOpening").value);
  const statementDay = numOrNaN($("cardStatement").value);
  const dueDay = numOrNaN($("cardDue").value);
  if (!name) return showFormError("cardError", "Enter a name for the card.");
  if (!(limit >= 0)) return showFormError("cardError", "Enter the credit limit (0 or more).");
  if (!(opening >= 0)) return showFormError("cardError", "Enter the amount currently owed (0 or more).");
  if (!isDay(statementDay) || !isDay(dueDay)) return showFormError("cardError", "Statement and due days must be between 1 and 31.");
  writeRecord("cards", editing.card, {
    name: name.slice(0, 80),
    currency: $("cardCurrency").value,
    creditLimit: limit,
    openingBalance: opening,
    statementDay,
    dueDay
  }, "cardError");
  editing.card = null;
  closeCard("cardFormCard");
}

function deleteCard(id) {
  const c = entity("card", id);
  if (!c) return;
  if (isReferenced("card", id)) return toast("This card has transactions. Delete or edit those transactions first.");
  removeRecord("cards", id, `card "${c.name}"`);
}

// ----- Debts & loans -----
function openDebtForm(id) {
  const d = id ? entity("debt", id) : null;
  $("debtForm").reset();
  editing.debt = d ? d.id : null;
  const locked = !!d && isReferenced("debt", d.id);
  $("debtFormTitle").textContent = d ? "Edit debt or loan" : "New debt or loan";
  $("debtSubmit").textContent = d ? "Save changes" : "Save debt";
  $("debtName").value = d ? d.name : "";
  $("debtDirection").value = d ? d.direction : "owe";
  $("debtDirection").disabled = locked;
  $("debtCurrency").value = d ? d.currency : "IQD";
  $("debtCurrency").disabled = locked;
  $("debtAmount").value = d ? d.originalAmount : "";
  $("debtDue").value = d ? d.dueDate : "";
  $("debtNotes").value = d ? d.notes : "";
  clearFormError("debtError");
  openCard("debtFormCard");
}

function saveDebt(e) {
  e.preventDefault();
  clearFormError("debtError");
  const name = $("debtName").value.trim();
  const amount = numOrNaN($("debtAmount").value);
  const due = $("debtDue").value;
  if (!name) return showFormError("debtError", "Enter the person or lender.");
  if (!(amount > 0)) return showFormError("debtError", "Enter an original amount greater than zero.");
  if (due && !isDate(due)) return showFormError("debtError", "Choose a valid due date or leave it empty.");
  writeRecord("debts", editing.debt, {
    name: name.slice(0, 80),
    direction: $("debtDirection").value,
    currency: $("debtCurrency").value,
    originalAmount: amount,
    dueDate: due,
    notes: $("debtNotes").value.trim().slice(0, 500)
  }, "debtError");
  editing.debt = null;
  closeCard("debtFormCard");
}

function deleteDebt(id) {
  const d = entity("debt", id);
  if (!d) return;
  if (isReferenced("debt", id)) return toast("This debt has repayments recorded. Delete or edit those transactions first.");
  removeRecord("debts", id, `debt "${d.name}"`);
}

// ----- Savings goals -----
function openGoalForm(id) {
  const g = id ? entity("savings", id) : null;
  $("goalForm").reset();
  editing.goal = g ? g.id : null;
  $("goalFormTitle").textContent = g ? "Edit savings goal" : "New savings goal";
  $("goalSubmit").textContent = g ? "Save changes" : "Save goal";
  $("goalName").value = g ? g.name : "";
  $("goalCurrency").value = g ? g.currency : "IQD";
  $("goalCurrency").disabled = !!g && isReferenced("savings", g.id);
  $("goalTarget").value = g ? g.targetAmount : "";
  $("goalSavedStart").value = g ? g.openingBalance : "";
  $("goalDate").value = g ? g.targetDate : "";
  clearFormError("goalError");
  openCard("goalFormCard");
}

function saveGoal(e) {
  e.preventDefault();
  clearFormError("goalError");
  const name = $("goalName").value.trim();
  const target = numOrNaN($("goalTarget").value);
  const saved = numOrNaN($("goalSavedStart").value);
  const date = $("goalDate").value;
  if (!name) return showFormError("goalError", "Enter a goal name.");
  if (!(target > 0)) return showFormError("goalError", "Enter a target amount greater than zero.");
  if (!(saved >= 0)) return showFormError("goalError", "Enter the amount already saved (0 or more).");
  if (date && !isDate(date)) return showFormError("goalError", "Choose a valid target date or leave it empty.");
  writeRecord("savings", editing.goal, {
    name: name.slice(0, 80),
    currency: $("goalCurrency").value,
    targetAmount: target,
    openingBalance: saved,
    targetDate: date
  }, "goalError");
  editing.goal = null;
  closeCard("goalFormCard");
}

function deleteGoal(id) {
  const g = entity("savings", id);
  if (!g) return;
  if (isReferenced("savings", id)) return toast("This goal has contributions or withdrawals. Delete or edit those transactions first.");
  removeRecord("savings", id, `goal "${g.name}"`);
}

// ----- Budgets (IQD only) -----
function openBudgetForm(id) {
  const b = id ? state.budgets.find(x => x.id === id) : null;
  $("budgetForm").reset();
  editing.budget = b ? b.id : null;
  $("budgetFormTitle").textContent = b ? "Edit budget" : "New budget";
  $("budgetSubmit").textContent = b ? "Save changes" : "Save budget";
  $("budScope").value = b ? b.scope : "overall";
  $("budSpace").value = b ? b.space : "all";
  $("budCategory").value = b ? b.category : "";
  $("budLimit").value = b ? b.limit : "";
  updateBudgetFormUI();
  clearFormError("budgetError");
  openCard("budgetFormCard");
}

function updateBudgetFormUI() {
  $("budCategoryGroup").classList.toggle("hidden", $("budScope").value !== "category");
}

function saveBudget(e) {
  e.preventDefault();
  clearFormError("budgetError");
  const scope = $("budScope").value;
  const space = $("budSpace").value;
  const category = scope === "category" ? $("budCategory").value.trim().slice(0, 60) : "";
  const limit = numOrNaN($("budLimit").value);
  if (scope === "category" && !category) return showFormError("budgetError", "Enter the category name.");
  if (!(limit > 0)) return showFormError("budgetError", "Enter a monthly limit greater than zero.");
  const duplicate = state.budgets.some(b => b.id !== editing.budget && b.scope === scope && b.space === space && norm(b.category) === norm(category));
  if (duplicate) return showFormError("budgetError", "A budget with this type, space, and category already exists. Edit that one instead.");
  writeRecord("budgets", editing.budget, { scope, space, category, limit, currency: "IQD" }, "budgetError");
  editing.budget = null;
  closeCard("budgetFormCard");
}

function deleteBudget(id) {
  const b = state.budgets.find(x => x.id === id);
  if (!b) return;
  removeRecord("budgets", id, `budget "${budgetName(b)}"`);
}

// Edit links used by the list renderers.
function editAccount(id) { openAccountForm(id); }
function editCard(id) { openCardForm(id); }
function editDebt(id) { openDebtForm(id); }
function editGoal(id) { openGoalForm(id); }
function editBudget(id) { openBudgetForm(id); }

// ----- Wiring -----
$("showTxForm").addEventListener("click", openNewTx);
$("hideTxForm").addEventListener("click", closeTxForm);
$("txCancel").addEventListener("click", closeTxForm);
$("transactionForm").addEventListener("submit", saveTransaction);
txEls.type.addEventListener("change", () => { buildTxOptions(); updateTxFormUI(); });
txEls.from.addEventListener("change", () => { buildTxOptions(); updateTxFormUI(); });
txEls.to.addEventListener("change", updateTxFormUI);

["txSearch"].forEach(id => $(id).addEventListener("input", renderTransactions));
["txFilterType", "txFilterSpace", "txFilterCurrency"].forEach(id => $(id).addEventListener("change", renderTransactions));

$("addAccountBtn").addEventListener("click", () => openAccountForm(null));
$("accountCancel").addEventListener("click", () => { editing.account = null; closeCard("accountFormCard"); });
$("accountForm").addEventListener("submit", saveAccount);

$("addCardBtn").addEventListener("click", () => openCardForm(null));
$("cardCancel").addEventListener("click", () => { editing.card = null; closeCard("cardFormCard"); });
$("cardForm").addEventListener("submit", saveCard);

$("addDebtBtn").addEventListener("click", () => openDebtForm(null));
$("debtCancel").addEventListener("click", () => { editing.debt = null; closeCard("debtFormCard"); });
$("debtForm").addEventListener("submit", saveDebt);

$("addGoalBtn").addEventListener("click", () => openGoalForm(null));
$("goalCancel").addEventListener("click", () => { editing.goal = null; closeCard("goalFormCard"); });
$("goalForm").addEventListener("submit", saveGoal);

$("addBudgetBtn").addEventListener("click", () => openBudgetForm(null));
$("budgetCancel").addEventListener("click", () => { editing.budget = null; closeCard("budgetFormCard"); });
$("budScope").addEventListener("change", updateBudgetFormUI);
$("budgetForm").addEventListener("submit", saveBudget);

window.addEventListener("online", updateSyncStatus);
window.addEventListener("offline", updateSyncStatus);
