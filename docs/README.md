# GOAT x402 Docs

This directory is the public documentation hub for **GOAT x402**. It is designed to help different readers quickly find the right material based on their role and use case.

The documentation here is intended to support four major needs:
- understanding what GOAT x402 is
- understanding why it matters
- onboarding merchants and operators
- integrating x402 into products, applications, and agent workflows

---

## 1. If you are new to GOAT x402

Start here if you are seeing GOAT x402 for the first time and want the fastest path to understanding the product.

### Recommended reading order
1. `what-is-x402.md`  
   A high-level introduction to what x402 is, what problem it solves, and how GOAT x402 fits into the payment flow.

2. `why-x402.md`  
   Explains the product value, adoption logic, and the business scenarios where GOAT x402 is most useful.

3. `x402-direct-vs-delegate.md`  
   Explains the two payment modes and when each one should be used.

4. `x402-faq.md`  
   A quick-answer reference for common questions around payment flow, user experience, fees, wallets, and operational expectations.

---

## 2. For developers

This section is for developers, technical PMs, integration engineers, and anyone implementing GOAT x402 in a product.

### Recommended reading order
1. `x402-developer-quickstart.md`  
   The fastest path to understanding the integration flow and getting started with implementation.

2. `x402-api-reference.md`  
   Covers API semantics, authentication, order creation, payment flow, status handling, and proof retrieval.

3. `x402-agent-integration-guide.md`  
   Covers agent workflows, AI-assisted implementation patterns, and agent-oriented integration design.

4. `x402-direct-vs-delegate.md`  
   Important for understanding the operational difference between payment modes and how they affect product behavior.

5. `x402-integration.md`  
   A deeper integration and architecture reference for developers who need more detail after the quickstart.

### Developer goal
By reading the documents above, a developer should be able to understand:
- how orders are created
- how the frontend and backend coordinate payment flow
- what DIRECT and DELEGATE mean in practice
- how proof, callbacks, and settlement fit into integration design

---

## 3. For business, BD, and partnerships

This section is for business-facing teammates who need to understand where GOAT x402 fits, how to explain it, and which scenarios it is best suited for.

### Recommended reading order
1. `what-is-x402.md`  
   Use this to understand the concept clearly and explain GOAT x402 at a high level.

2. `why-x402.md`  
   Use this to understand the business value, adoption logic, and why GOAT x402 matters in merchant and agent economy contexts.

3. `x402-direct-vs-delegate.md`  
   Important for explaining the product model and why different merchants may choose different payment modes.

4. `merchant-guide.md`  
   Useful for understanding the merchant-facing flow in practice, including onboarding, dashboard usage, API key setup, and operational steps.

5. `x402-faq.md`  
   Useful as a short-form business-facing support document for common questions.

### Business goal
By reading the documents above, business-facing teammates should be able to understand:
- what GOAT x402 is
- how to position it clearly
- which scenarios fit DIRECT vs DELEGATE
- how merchant setup and usage look in practice

---

## 4. For operations, onboarding, and merchant support

This section is for operations teammates, onboarding managers, merchant support staff, and anyone responsible for helping merchants get started and use the system correctly.

### Recommended reading order
1. `x402-onboarding-guide.md`  
   Explains the onboarding flow and the steps merchants need to complete before going live.

2. `merchant-guide.md`  
   A practical merchant operations guide with screenshots, configuration examples, and merchant-side setup steps.

3. `x402-faq.md`  
   A useful reference for answering common merchant questions and clarifying expected system behavior.

4. `x402-direct-vs-delegate.md`  
   Useful when a merchant needs help deciding which payment mode is more appropriate.

### Operations goal
By reading the documents above, operations and support teammates should be able to understand:
- how merchants register and configure the system
- what settings and setup steps matter most
- what common merchant questions look like
- how to explain payment mode differences in plain language

---

## 5. By topic

### Product understanding
- `what-is-x402.md`
- `why-x402.md`

### Payment mode design
- `x402-direct-vs-delegate.md`

### Merchant onboarding and usage
- `x402-onboarding-guide.md`
- `merchant-guide.md`

### Technical integration
- `x402-developer-quickstart.md`
- `x402-api-reference.md`
- `x402-integration.md`

### Agent and AI-driven integration
- `x402-agent-integration-guide.md`

### Quick answers and common questions
- `x402-faq.md`

---

## 6. Full document list

| Document | Primary Audience | Main Purpose |
| --- | --- | --- |
| `what-is-x402.md` | Everyone | Explains what x402 is and what GOAT x402 does |
| `why-x402.md` | Business, product, partnerships | Explains why GOAT x402 matters and where it creates value |
| `x402-direct-vs-delegate.md` | Everyone | Explains the two payment modes and their differences |
| `x402-onboarding-guide.md` | Operations, onboarding, merchants | Explains the onboarding flow and go-live steps |
| `merchant-guide.md` | Merchants, operations, support | Practical merchant setup and usage guide with screenshots |
| `x402-developer-quickstart.md` | Developers | Fastest path to integration |
| `x402-api-reference.md` | Developers | API semantics, lifecycle, and integration details |
| `x402-integration.md` | Developers, technical PMs | Deeper architecture and SDK integration reference |
| `x402-agent-integration-guide.md` | Developers, AI agent builders | Guidance for agent and AI-assisted integration workflows |
| `x402-faq.md` | Everyone | Common questions and short-form answers |

---

## 7. Notes

- Images referenced by `merchant-guide.md` are stored in `docs/images/`.
- This `docs/` directory is intended to serve as the public-facing documentation set in the repository.
- Older root-level files such as `API.md`, `DEVELOPER_FAST.md`, and `ONBOARDING.md` may still exist in the repository. The files in `docs/` are intended to function as the newer structured documentation set.
