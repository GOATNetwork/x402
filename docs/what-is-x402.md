# What is x402?

> An introductory document for merchants, developers, product teams, and operations teams.  
> This document explains what x402 is, what problems it solves, which scenarios it fits, and what role it plays within GOAT Network.

---

## One-Line Definition

**x402 is a crypto payment protocol built around HTTP 402 “Payment Required”, designed to let apps, APIs, content, and agents request, complete, and verify payments natively within an internet request flow.**

In simple terms:

> **x402 turns payment into part of the request flow itself, instead of an external checkout process.**

---

## What Problem Does x402 Solve?

In the traditional internet stack, charging for a service usually depends on:

- user accounts and registration
- subscription systems
- credit cards or third-party payment gateways
- manual billing systems
- custom reconciliation and access control logic

In Web3, it may seem easier to use wallets, but practical problems still remain:

- payment flows are not standardized, so each project builds its own version
- supporting multiple chains, wallets, and tokens creates high complexity
- small payments are often too expensive or too cumbersome to justify on-chain
- after payment, teams still need to build status verification, callbacks, fulfillment, and reconciliation themselves
- there is no broadly adopted standard for pay-per-call APIs, pay-per-use content, or agent-driven payments

x402 is designed to standardize this entire problem space.

---

## The Core Idea Behind x402

The core idea of x402 comes from a long-reserved HTTP status code:

- **HTTP 402 — Payment Required**

This status code existed for many years, but was never widely activated in real-world products.

x402 applies it to programmable money:

1. A user or agent requests a resource
2. If payment is required, the server returns **HTTP 402**
3. The response contains the payment requirements
4. The user completes payment
5. The system verifies payment and continues service delivery

That means payment is no longer an external step detached from the service flow — it becomes part of the request protocol itself.

---

## What Does x402 Mean in Practice?

With x402, many previously awkward payment scenarios become much more natural:

### 1. Pay-Per-Request APIs
Developers do not always need accounts, card setup, or subscriptions. They can pay directly for a single API request.

### 2. Pay-Per-Use Content
Users do not always need a monthly subscription. They can pay for a single article, download, or service interaction.

### 3. AI / Agent Payments
Agents can complete payments automatically during execution and continue calling external services.

### 4. Payment-Triggered Business Logic
Payment is not just about receiving funds. It can also be connected to downstream actions, such as:

- unlocking content
- triggering contract logic
- minting NFTs
- executing on-chain actions

---

## How Is x402 Different from Ordinary Payment Methods?

### Compared with Traditional Payment Gateways
Traditional payments rely on:

- account systems
- card networks and banking rails
- monthly billing or centralized settlement systems

x402 is better suited for:

- on-chain payments
- programmable payments
- micropayments
- API, agent, and Web3-native monetization

### Compared with a Simple Wallet Transfer
A normal wallet transfer only solves the problem of sending funds. It does not automatically solve:

- how requests are standardized
- how the server knows what should be paid
- how service delivery is tied to payment success
- how payment is bound to a specific order
- how to support callbacks and proof

x402 solves a **payment protocol layer**, not just a token transfer.

---

## What Role Does x402 Play in GOAT Network?

Within GOAT Network, x402 is more than a payment button. It acts as a broader:

> **payment + settlement + verifiable delivery layer**

In the GOAT implementation, x402 helps merchants and developers:

- support multi-chain payments
- integrate through a unified SDK
- obtain proof after payment completes
- support callback / execution in more advanced scenarios
- provide more standardized payment capability for merchants, apps, and agents

This makes x402 well-suited to serve as:

- a payment capability layer for builders
- a settlement integration layer for merchants
- automated payment infrastructure for agents

---

## The Two Main GOAT x402 Modes

The current GOAT x402 implementation mainly supports two modes:

### 1. DIRECT
The user pays directly to the merchant address.

Suitable for:
- simple payments
- paid content
- API monetization
- lightweight checkout scenarios

### 2. DELEGATE
Payment is not just about receiving funds. It also supports more advanced settlement and post-payment execution logic.

Suitable for:
- callback-enabled flows
- NFT minting
- in-game on-chain actions
- agent-driven execution
- any scenario where payment success should trigger business logic automatically

A simple way to remember it:

- **DIRECT = get paid**
- **DELEGATE = get paid + execute logic**

---

## Why Is x402 a Good Fit for Agent and AI Scenarios?

x402 is especially useful in agent-driven workflows because it naturally supports:

- machine-readable payment flows
- protocol-level coupling between requests and payments
- automated invocation
- standardized post-payment verification

For agents, this means:

- they do not need a human to step out of the workflow and pay manually
- they can complete payments during execution
- accessing a paid API can become just another programmable step in a task pipeline

This is why x402 is often seen as an important piece of infrastructure for the emerging **agent economy**.

---

## Which Scenarios Fit x402 Best?

x402 is especially well suited for:

- API monetization
- AI / ML inference payments
- paid content or download access
- in-game purchases
- agent / bot payments
- payment-triggered on-chain execution flows

---

## Which Scenarios Are Less Suitable for x402?

x402 may not be the best fit for:

- fixed monthly subscription services
- large one-time payments
- fiat-only audiences with no wallet usage
- ordinary websites with no blockchain or programmable payment relevance

In those cases, traditional payment systems may be more direct.

---

## How Do You Get Started with x402?

A typical onboarding path looks like this:

1. Register a Merchant Account
2. Configure Receiving Address
3. Generate API Credentials
4. Choose an integration path (GitHub SDK or Agent Integration)
5. Test and go live

Recommended companion documents:

- **x402 Onboarding Guide**
- **Merchant Guide**
- **Developer Quick Start**
- **DIRECT vs DELEGATE**
- **x402 FAQ**

---

## One-Line Summary

**The value of x402 is not just that it enables payment, but that it makes payment part of the internet request and service delivery flow itself.**

For merchants, it provides a more standardized monetization layer.  
For developers, it provides a more integrable payment protocol.  
For agents, it provides programmable payment infrastructure.

---

Contact email: x402support@goat.network
