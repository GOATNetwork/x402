# MerchantCallback Quick Start Guide

> `topup-service` is the exception: deploy `TopupCallback` with
> `script/DeployTopupCallback.s.sol`. It uses a dedicated EIP-712 domain and does
> not support `withCalldata`. Regular DELEGATE merchants use `MerchantCallback`.

## 1. Environment Setup

```bash
# Ensure a .env file exists and contains your deployer key
cat > .env << EOF
PRIVATE_KEY=your_private_key_here
EOF
```

## 2. Build Contracts

```bash
forge build
```

## 3. Run Tests

```bash
forge test --match-contract MerchantCallbackTest -vv
```

You should see all 8 tests passing:

```text
[PASS] testEip3009Callback() (gas: 207230)
[PASS] testEip3009DuplicateNonce() (gas: 200542)
[PASS] testMultipleCallbacks() (gas: 1302938)
[PASS] testOnlyOwnerFunctions() (gas: 18029)
[PASS] testPermit2Callback() (gas: 182984)
[PASS] testPermit2DuplicateNonce() (gas: 175997)
[PASS] testResetCallbacks() (gas: 287944)
[PASS] testShouldRevertToggle() (gas: 214431)
```

## 4. Deploy to a Local Testnet

### Start a local node

```bash
# Run this in another terminal window
anvil
```

### Deploy the contract

```bash
forge script script/DeployMerchantCallback.s.sol:DeployMerchantCallback \
  --rpc-url http://localhost:8545 \
  --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

A successful deployment prints output like:

```text
===========================================
MerchantCallback deployed successfully!
===========================================
Contract Address: 0x5FbDB2315678afecb367f032d93F642f64180aa3
Deployer: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
Chain ID: 31337
===========================================
```

## 5. Deploy to BSC Testnet

```bash
forge script script/DeployMerchantCallback.s.sol:DeployMerchantCallback \
  --rpc-url bsc_testnet \
  --broadcast \
  --verify \
  --private-key $PRIVATE_KEY
```

## 6. Configure the Database

After deployment, insert or update the callback contract config:

```sql
-- Connect to database
psql -h localhost -U postgres -d goatx402

-- Upsert callback contract configuration
INSERT INTO merchant_callback_contract (
    merchant_id,
    chain_id,
    spent_address,
    spent_permit2_func_abi,
    spent_erc3009_func_abi
) VALUES (
    'default',  -- your merchant ID
    97,         -- BSC Testnet (or 31337 for local)
    '0xYourContractAddress',
    '{"name":"x402SpentPermit2","type":"function","stateMutability":"nonpayable","inputs":[{"name":"owner","type":"address"},{"name":"amount","type":"uint256"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"},{"name":"signature","type":"bytes"}],"outputs":[]}',
    '{"name":"x402SpentEip3009","type":"function","stateMutability":"nonpayable","inputs":[{"name":"owner","type":"address"},{"name":"amount","type":"uint256"},{"name":"validAfter","type":"uint256"},{"name":"validBefore","type":"uint256"},{"name":"nonce","type":"bytes32"},{"name":"v","type":"uint8"},{"name":"r","type":"bytes32"},{"name":"s","type":"bytes32"}],"outputs":[]}'
) ON CONFLICT (merchant_id, chain_id) DO UPDATE SET
    spent_address = EXCLUDED.spent_address,
    spent_permit2_func_abi = EXCLUDED.spent_permit2_func_abi,
    spent_erc3009_func_abi = EXCLUDED.spent_erc3009_func_abi,
    updated_at = NOW();
```

## 7. Test Callback Functions

### Use `cast` commands

```bash
# Save addresses and RPC target
CONTRACT_ADDRESS=0xYourContractAddress
RPC_URL=http://localhost:8545  # or a BSC testnet RPC endpoint

# Check callback counters
cast call $CONTRACT_ADDRESS "getEip3009CallbackCount()" --rpc-url $RPC_URL
cast call $CONTRACT_ADDRESS "getPermit2CallbackCount()" --rpc-url $RPC_URL

# Simulate an EIP-3009 callback (must be sent by an authorized caller)
cast send $CONTRACT_ADDRESS \
  "x402SpentEip3009(address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)" \
  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
  1000000 \
  $(date +%s) \
  $(($(date +%s) + 3600)) \
  0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef \
  27 \
  0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --rpc-url $RPC_URL

# Verify callback was recorded
cast call $CONTRACT_ADDRESS "getEip3009CallbackCount()" --rpc-url $RPC_URL
# Expected: 1

# Read callback detail
cast call $CONTRACT_ADDRESS "getEip3009Callback(uint256)" 0 --rpc-url $RPC_URL
```

## 8. Integrate with x402

### End-to-end test flow

1. Start the x402 service.

```bash
go run cmd/x402d/main.go
```

2. Create a test order.

```bash
# Create an ERC20_3009 or ERC20_APPROVE_PERMIT2 order via API
curl -X POST http://localhost:8080/api/v1/orders \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key" \
  -H "X-Timestamp: $(date +%s)" \
  -H "X-Nonce: your_request_nonce" \
  -H "X-Sign: your_signature" \
  -d '{
    "flow": "ERC20_3009",
    "token_symbol": "USDC",
    "amount_wei": "1000000",
    "chain_id": 97,
    "from_address": "0xUserAddress"
  }'
```

3. Complete payment from the user wallet.

4. Verify callback execution.

```bash
# Verify contract received callback
cast call $CONTRACT_ADDRESS "getEip3009CallbackCount()" --rpc-url $RPC_URL

# Read latest callback
cast call $CONTRACT_ADDRESS "getEip3009Callback(uint256)" 0 --rpc-url $RPC_URL
```

## 9. Monitor Callback Events

### Live event monitoring

```bash
# Monitor EIP-3009 callback events
cast logs --address $CONTRACT_ADDRESS \
  "Eip3009CallbackReceived(address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)" \
  --rpc-url $RPC_URL \
  --follow

# Monitor Permit2 callback events
cast logs --address $CONTRACT_ADDRESS \
  "Permit2CallbackReceived(address,uint256,uint256,uint256,bytes)" \
  --rpc-url $RPC_URL \
  --follow
```

## 10. Administrative Operations

### Reset callback history

```bash
cast send $CONTRACT_ADDRESS "resetCallbacks()" \
  --private-key $PRIVATE_KEY \
  --rpc-url $RPC_URL
```

### Toggle revert mode for testing

```bash
# Enable revert mode (callbacks will revert)
cast send $CONTRACT_ADDRESS "setShouldRevert(bool)" true \
  --private-key $PRIVATE_KEY \
  --rpc-url $RPC_URL

# Disable revert mode
cast send $CONTRACT_ADDRESS "setShouldRevert(bool)" false \
  --private-key $PRIVATE_KEY \
  --rpc-url $RPC_URL
```

## Command Reference

### Contract information

```bash
# Get owner
cast call $CONTRACT_ADDRESS "owner()" --rpc-url $RPC_URL

# Check revert mode
cast call $CONTRACT_ADDRESS "shouldRevert()" --rpc-url $RPC_URL
```

### Callback queries

```bash
# Total EIP-3009 callbacks
cast call $CONTRACT_ADDRESS "getEip3009CallbackCount()" --rpc-url $RPC_URL

# Total Permit2 callbacks
cast call $CONTRACT_ADDRESS "getPermit2CallbackCount()" --rpc-url $RPC_URL

# Read a specific callback
cast call $CONTRACT_ADDRESS "getEip3009Callback(uint256)" INDEX --rpc-url $RPC_URL
cast call $CONTRACT_ADDRESS "getPermit2Callback(uint256)" INDEX --rpc-url $RPC_URL
```

### Nonce checks

```bash
# Check whether an EIP-3009 nonce has been used
cast call $CONTRACT_ADDRESS "isEip3009NonceUsed(bytes32)" NONCE --rpc-url $RPC_URL

# Check whether a Permit2 nonce has been used
cast call $CONTRACT_ADDRESS "isPermit2NonceUsed(uint256)" NONCE --rpc-url $RPC_URL
```

## Troubleshooting

### Issue: Contract did not receive callback

1. Check database config.

```sql
SELECT * FROM merchant_callback_contract WHERE merchant_id = 'your_merchant_id';
```

2. Check contract address correctness.

```bash
cast code $CONTRACT_ADDRESS --rpc-url $RPC_URL
# Should return contract bytecode, not 0x
```

3. Check x402 logs.

Review payout executor logs to confirm callback invocation attempts.

### Issue: Callback transaction failed

1. Check whether revert mode is enabled.

```bash
cast call $CONTRACT_ADDRESS "shouldRevert()" --rpc-url $RPC_URL
# Expected: false
```

2. Inspect failed transaction details.

```bash
cast tx TRANSACTION_HASH --rpc-url $RPC_URL
```

## More Information

See related files:

- [MERCHANT_CALLBACK.md](./MERCHANT_CALLBACK.md) - Full documentation
- [src/MerchantCallback.sol](./src/MerchantCallback.sol) - Contract source
- [test/MerchantCallback.t.sol](./test/MerchantCallback.t.sol) - Test suite

## Notes

- The contract passes the full unit test suite.
- Typical gas usage is around 55,000-60,000 per callback.
- Callback history is unbounded and queryable.
- Access control is implemented via OpenZeppelin `Ownable`.
- Every callback emits events for off-chain monitoring.
