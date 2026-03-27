# x402 DApp Integration Agent Guide

## 1. What this agent does

`x402-dapp-integration` is an integration-focused Agent/Skill used to turn an **existing Web DApp** into a DApp that supports **x402 payments**.

Its goal is not to rebuild the DApp from scratch. Instead, it adds x402 payment gates to paid or protected actions while preserving the existing business logic as much as possible.

This agent can start from either of the following inputs:

- **A local project path**
- **A Git repository**

To reduce risk, the agent should not modify the original project directly. It should first create a safe working copy and perform the integration there.

---

## 2. Core capabilities

- Analyze an existing DApp from a local path or Git repository
- Avoid direct edits to the original project by working in a safe copied workspace
- Preserve the original business logic and only add x402 payment gates before paid or protected actions
- Keep merchant credentials backend-only
- Never expose `API_SECRET` in the frontend
- Fill in missing backend APIs, frontend payment state machine, local validation, and delivery documentation

---

## 3. Intended use cases

Use this agent when you need to:

- Add payment gating to downloads, queries, generation, API calls, minting, submissions, or other protected actions
- Introduce pay-per-use or protected access into an existing SaaS app or DApp
- Validate x402 integration feasibility without refactoring the full product
- Deliver an implementation that can be reviewed, tested locally, and maintained by other developers

Do not use it to:

- Build a brand-new DApp from scratch
- Refactor the entire frontend/backend architecture
- Expose merchant secrets to the client
- Re-architect the full product around payments

---

## 4. Security boundaries

The integration must follow these security rules:

1. `API_SECRET` must stay on the backend only and must never be exposed to the frontend.
2. Merchant credentials must only be read and used by the backend.
3. Wallet signing must happen in a user-controlled wallet context.
4. Do not make risky direct edits to the original repository; prefer integration in a safe working copy.
5. Preserve existing business logic and only add payment enforcement to explicitly protected actions.
6. Do not call sensitive Merchant APIs directly from the frontend.
7. If using DELEGATE + callback, do not hardcode EIP-712 domain/type on the frontend; use the `calldataSignRequest` returned by the order.

---

## 5. Default deliverables

`x402-dapp-integration` should normally deliver the following:

### 5.1 Backend interfaces

At minimum:

- Order creation endpoint
- Order status endpoint
- Proof retrieval endpoint or proof lookup logic
- Calldata signature submission endpoint (for DELEGATE + callback flows)
- Order cancellation endpoint or cancellation logic
- Payment confirmation / verification logic
- Access control for protected resources or actions
- Environment variable and merchant configuration loading

### 5.2 Frontend payment state machine

At minimum:

- idle
- payment_required
- wallet_pending
- signing
- submitting
- confirming
- success
- failed
- cancelled
- expired

### 5.3 Local validation

At minimum:

- Local startup instructions
- Environment variable setup guide
- Minimal payment flow validation steps
- Common error and troubleshooting notes
- Order cancellation and expiration validation
- Proof retrieval validation

### 5.4 Delivery documentation

Document:

- Which modules were changed
- Which interfaces/components were added
- How to configure environment variables
- How to run locally
- How to validate and accept the payment flow
- How timeout and failed orders are handled

---

## 6. Recommended base configuration

Use the following environment variable naming consistently:

```bash
GOATX402_API_URL=https://api.x402.goat.network
GOATX402_API_KEY=your_api_key
GOATX402_API_SECRET=your_api_secret
GOATX402_MERCHANT_ID=your_merchant_id
```

Notes:

- **Production base URL**: `https://api.x402.goat.network`
- Common local Core / demo URL: `http://localhost:8286`
- If older docs mention `GOATX402_BASE_URL`, migrate to `GOATX402_API_URL`

---

## 7. Standard integration flow

### Step 1: Identify the project shape

Identify:

- Frontend framework (React / Next.js / Vue / others)
- Backend shape (Node / serverless / API routes / separate service)
- Which actions need to be protected or paid

### Step 2: Copy into a safe working directory

- Do not modify the original project directly
- Create a safe editable copy
- Perform integration, testing, and delivery in that copy

### Step 3: Define protected actions

Clarify:

- Which buttons, endpoints, pages, or operations require payment first
- How successful payment unlocks the existing business action
- How failure, cancellation, or expiration should be handled

### Step 4: Implement backend integration

The backend should:

- Read merchant credentials
- Call `POST /api/v1/orders` to create x402 orders
- Query order status
- Retrieve proof
- Submit calldata signatures when needed
- Cancel orders when needed
- Verify completed payment
- Protect resource access

### Step 5: Implement frontend payment state machine

The frontend should:

- Trigger the payment flow
- Show payment state to the user
- Guide wallet signing/payment steps
- Handle success, failure, cancellation, and timeout
- If `calldataSignRequest` exists, sign first and send the signature back to the backend
- Execute the actual transfer to `payToAddress`
- Resume the original business action after payment succeeds

### Step 6: Run local validation

At minimum validate:

- Happy-path payment flow
- User cancellation flow
- Order expiration flow
- Missing or invalid backend configuration
- Blocking of protected actions before payment
- Proof retrieval
- Order cancellation behavior

### Step 7: Deliver documentation

Produce a final handoff document so other developers can maintain and validate the integration.

---

## 8. API semantics that must stay aligned with the API reference

To keep this guide consistent with the API reference, the integration must explicitly preserve these semantics:

### 8.1 `HTTP 402` from Create Order is the normal success path

- When `POST /api/v1/orders` returns `HTTP 402 Payment Required`, the order is usually created successfully
- This is not a normal application error; it is the expected x402 protocol response
- Both frontend and backend must avoid misclassifying it as failure

### 8.2 Who the user actually pays

- In all flow types, the user-side payment action is a transfer to **`payToAddress`**
- `DIRECT`: usually the merchant address
- `DELEGATE`: usually the TSS / delegated settlement address

### 8.3 Common backend endpoint mapping

| Capability | Endpoint |
| --- | --- |
| Create order | `POST /api/v1/orders` |
| Query status | `GET /api/v1/orders/{order_id}` |
| Retrieve proof | `GET /api/v1/orders/{order_id}/proof` |
| Submit signature | `POST /api/v1/orders/{order_id}/calldata-signature` |
| Cancel order | `POST /api/v1/orders/{order_id}/cancel` |
| Get merchant info | `GET /merchants/{merchant_id}` |

---

## 9. Payment modes and state handling

### 9.1 Payment modes

| Mode | Flow Types | User transfer target | Callback support |
| --- | --- | --- | --- |
| `DIRECT` | `ERC20_DIRECT`, `SOL_DIRECT` | Merchant address | No |
| `DELEGATE` | `ERC20_3009`, `ERC20_APPROVE_XFER`, `SOL_APPROVE_XFER` | TSS / delegated settlement address | Yes |

### 9.2 Common order states

At minimum, the integration should handle these states:

- `CHECKOUT_VERIFIED`
- `PAYMENT_CONFIRMED`
- `INVOICED`
- `FAILED`
- `EXPIRED`
- `CANCELLED`

Both the frontend state machine and the backend fulfillment logic should cover them.

---

## 10. Recommendations for order cancellation and proof handling

### 10.1 Order cancellation

- In practice, only `CHECKOUT_VERIFIED` orders can usually be cancelled
- If the user closes the payment page, times out, or abandons the flow, the backend should cancel promptly
- Do not leave long-lived unpaid orders hanging

### 10.2 Proof handling

- After payment confirmation, the backend should retrieve and persist proof
- Proof is useful for reconciliation, auditability, fulfillment evidence, and dispute handling
- If your DApp triggers downstream fulfillment, store proof in backend records

---

## 11. Recommended repository structure

Keep both the **unpacked source directory** and the **distribution package**:

```text
docs/
  skills/
    x402-dapp-integration/
      SKILL.md
      scripts/
      references/
      assets/
    x402-dapp-integration.skill
```

Notes:

- **Unpacked directory**: for review, editing, and version control
- **`.skill` package**: for download, import, and distribution

Do not keep only a zip file in the repository if the unpacked source is missing.

---

## 12. Acceptance criteria

Use the following as baseline acceptance criteria:

- The integration can start from either a local path or a Git repository
- The original project is not modified directly
- Protected actions cannot run before payment
- The original business flow resumes after successful payment
- `API_SECRET` is not exposed in the frontend
- Merchant configuration is read correctly by the backend
- `POST /api/v1/orders` and its `402` semantics are handled correctly
- The frontend correctly handles `calldataSignRequest` when applicable
- The backend can query status, retrieve proof, and cancel stale orders
- Local validation steps are complete and reproducible
- Delivery documentation is sufficient for future maintainers

---

## 13. Relationship to the API reference

This guide describes the **role, boundaries, deliverables, and implementation flow** of the Agent/Skill.

Related document:

- `docs/x402-api-reference.md`: API capability, endpoint semantics, and response structure

The relationship is:

- **Protocol document**: defines how an x402 Agent interacts with payment capabilities
- **API reference**: defines core endpoints and semantics
- **Integration guide**: defines how to adapt an existing DApp to support x402 payments

---

Contact email: x402support@goat.network
