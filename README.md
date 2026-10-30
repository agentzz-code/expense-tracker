
# Finance

A personal finance management app designed to make tracking money simple, reliable, and organized.

## Core principles

- IQD is the primary reporting currency.
- Support multiple currencies, including IQD, USD, and EUR.
- Keep Personal, Family, and Business transactions in one unified financial system.
- Track cash, bank accounts, credit cards, debts, and savings.
- Preserve the original currency and exchange rate used for every transaction.
- Support official, Iraqi market, and manually entered exchange rates.
- Work across web, iPhone, and Android.
- Support English, Arabic, and Kurdish Sorani.
- Provide offline access and reliable synchronization.

## Technology

- HTML, CSS, and JavaScript
- Firebase Authentication
- Cloud Firestore
- Firebase Storage
- Progressive Web App (PWA)
- Cloudflare Workers for scheduled services

## Development priorities

1. Application foundation and navigation.
2. Secure authentication and database permissions.
3. Exchange-rate engine.
4. Accounts, transactions, and transfers.
5. Budgets, credit cards, debts, and savings.
6. Reports, exports, and attachments.
7. Offline support, synchronization, and notifications.

## Security

- One authorized owner account.
- Firebase authentication and owner-only database access.
- Optional PIN lock.
- No sensitive administrative credentials in client-side code.

## Important financial rules

- Transfers between owned accounts are not income or expenses.
- Opening balances are not income.
- Historical transactions retain their recorded exchange rates.
- Debt repayments and savings allocations must not be double-counted.
- Exchange rates must always display their source and last update time.
