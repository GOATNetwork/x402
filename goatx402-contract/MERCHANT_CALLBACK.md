# MerchantCallback Contract

## Overview

`MerchantCallback` is a test contract for receiving payment callbacks from goatx402. It implements two callback functions:

1. **x402SpentEip3009** - Callback for EIP-3009 (transferWithAuthorization) payments
2. **x402SpentPermit2** - Callback for Permit2 payments

The platform `topup-service` uses the separate `TopupCallback`: it has the
`GoatX402 Topup Callback` / `1` EIP-712 domain and deliberately exposes no
`withCalldata` entrypoints. Merchant integrations should continue to use
`MerchantCallback`.

## Features

- ✅ Tracks all callback invocations with full parameter history
- ✅ Emits events for each callback
- ✅ Prevents duplicate nonce usage (for testing)
- ✅ Toggle revert mode for error handling tests
- ✅ Query callback history by index
- ✅ Owner-only administrative functions

## Contract Structure

### State Variables

```solidity
// Callback history arrays
Eip3009Callback[] public eip3009Callbacks;
Permit2Callback[] public permit2Callbacks;

// Nonce tracking
mapping(bytes32 => bool) public eip3009NonceUsed;
mapping(uint256 => bool) public permit2NonceUsed;

// Test mode flag
bool public shouldRevert;
```

### Main Functions

#### x402SpentEip3009
```solidity
function x402SpentEip3009(
    address owner,
    uint256 amount,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce,
    uint8 v,
    bytes32 r,
    bytes32 s
) external
```

Called by x402 after successful EIP-3009 payment.

#### x402SpentPermit2
```solidity
function x402SpentPermit2(
    address owner,
    uint256 amount,
    uint256 nonce,
    uint256 deadline,
    bytes calldata signature
) external
```

Called by x402 after successful Permit2 payment.

### View Functions

```solidity
// Get callback counts
function getEip3009CallbackCount() external view returns (uint256)
function getPermit2CallbackCount() external view returns (uint256)

// Get callback details by index
function getEip3009Callback(uint256 index) external view returns (...)
function getPermit2Callback(uint256 index) external view returns (...)

// Check nonce usage
function isEip3009NonceUsed(bytes32 nonce) external view returns (bool)
function isPermit2NonceUsed(uint256 nonce) external view returns (bool)
```

### Admin Functions (Owner Only)

```solidity
// Toggle revert mode for testing
function setShouldRevert(bool _shouldRevert) external onlyOwner

// Reset callback history
function resetCallbacks() external onlyOwner
```

## Deployment

### Prerequisites

1. Set up environment variables in `.env`:
```bash
PRIVATE_KEY=your_private_key_here
RPC_URL=your_rpc_url
```

2. Ensure you have Foundry installed:
```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

### Deploy to Local Network

```bash
# Start local Anvil node (in a separate terminal)
anvil

# Deploy contract
forge script script/DeployMerchantCallback.s.sol:DeployMerchantCallback \
  --rpc-url http://localhost:8545 \
  --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

### Deploy to BSC Testnet

```bash
forge script script/DeployMerchantCallback.s.sol:DeployMerchantCallback \
  --rpc-url bsc_testnet \
  --broadcast \
  --verify \
  --private-key $PRIVATE_KEY
```

### Deploy to GOAT Testnet

```bash
forge script script/DeployMerchantCallback.s.sol:DeployMerchantCallback \
  --rpc-url goat_testnet3 \
  --broadcast \
  --private-key $PRIVATE_KEY
```

## Testing

### Run All Tests

```bash
forge test -vvv
```

### Run Specific Test

```bash
forge test --match-contract MerchantCallbackTest -vvv
```

### Run with Gas Report

```bash
forge test --gas-report
```

### Test Coverage

```bash
forge coverage
```

## Integration with x402

### 1. Store Contract Address in Database

After deploying, store the contract address in the `merchant_callback_contract` table:

```sql
INSERT INTO merchant_callback_contract (
    merchant_id,
    chain_id,
    spent_address,
    spent_permit2_func_abi,
    spent_erc3009_func_abi
) VALUES (
    'your_merchant_id',
    97,  -- BSC Testnet chain ID
    '0xYourContractAddress',
    '{"name":"x402SpentPermit2","type":"function","stateMutability":"nonpayable","inputs":[{"name":"owner","type":"address"},{"name":"amount","type":"uint256"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"},{"name":"signature","type":"bytes"}],"outputs":[]}',
    '{"name":"x402SpentEip3009","type":"function","stateMutability":"nonpayable","inputs":[{"name":"owner","type":"address"},{"name":"amount","type":"uint256"},{"name":"validAfter","type":"uint256"},{"name":"validBefore","type":"uint256"},{"name":"nonce","type":"bytes32"},{"name":"v","type":"uint8"},{"name":"r","type":"bytes32"},{"name":"s","type":"bytes32"}],"outputs":[]}'
);
```

### 2. Test EIP-3009 Callback

Create a test order with `ERC20_3009` flow and verify the callback is received:

```bash
# Check callback count before
cast call $CONTRACT_ADDRESS "getEip3009CallbackCount()" --rpc-url $RPC_URL

# Process payment through x402
# ... (payment processing)

# Check callback count after
cast call $CONTRACT_ADDRESS "getEip3009CallbackCount()" --rpc-url $RPC_URL

# Get callback details
cast call $CONTRACT_ADDRESS "getEip3009Callback(uint256)" 0 --rpc-url $RPC_URL
```

### 3. Test Permit2 Callback

Create a test order with `ERC20_APPROVE_PERMIT2` flow:

```bash
# Check callback count
cast call $CONTRACT_ADDRESS "getPermit2CallbackCount()" --rpc-url $RPC_URL

# Get callback details after payment
cast call $CONTRACT_ADDRESS "getPermit2Callback(uint256)" 0 --rpc-url $RPC_URL
```

### 4. Monitor Callbacks via Events

```bash
# Watch for Eip3009 callbacks
cast logs --address $CONTRACT_ADDRESS \
  "Eip3009CallbackReceived(address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)" \
  --rpc-url $RPC_URL

# Watch for Permit2 callbacks
cast logs --address $CONTRACT_ADDRESS \
  "Permit2CallbackReceived(address,uint256,uint256,uint256,bytes)" \
  --rpc-url $RPC_URL
```

## Testing Error Handling

### Enable Revert Mode

```bash
# Enable revert mode (only owner)
cast send $CONTRACT_ADDRESS \
  "setShouldRevert(bool)" true \
  --private-key $PRIVATE_KEY \
  --rpc-url $RPC_URL

# Now callbacks will revert
# Test x402's error handling

# Disable revert mode
cast send $CONTRACT_ADDRESS \
  "setShouldRevert(bool)" false \
  --private-key $PRIVATE_KEY \
  --rpc-url $RPC_URL
```

## Useful Commands

### Check Callback History

```bash
# Total callbacks
cast call $CONTRACT_ADDRESS "getEip3009CallbackCount()" --rpc-url $RPC_URL
cast call $CONTRACT_ADDRESS "getPermit2CallbackCount()" --rpc-url $RPC_URL

# Get specific callback
cast call $CONTRACT_ADDRESS "getEip3009Callback(uint256)" 0 --rpc-url $RPC_URL
cast call $CONTRACT_ADDRESS "getPermit2Callback(uint256)" 0 --rpc-url $RPC_URL
```

### Check Nonce Usage

```bash
# EIP-3009 nonce
cast call $CONTRACT_ADDRESS \
  "isEip3009NonceUsed(bytes32)" \
  0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef \
  --rpc-url $RPC_URL

# Permit2 nonce
cast call $CONTRACT_ADDRESS "isPermit2NonceUsed(uint256)" 12345 --rpc-url $RPC_URL
```

### Reset Callback History

```bash
# Clear all callbacks (owner only)
cast send $CONTRACT_ADDRESS \
  "resetCallbacks()" \
  --private-key $PRIVATE_KEY \
  --rpc-url $RPC_URL
```

### Transfer Ownership

```bash
cast send $CONTRACT_ADDRESS \
  "transferOwnership(address)" \
  0xNewOwnerAddress \
  --private-key $PRIVATE_KEY \
  --rpc-url $RPC_URL
```

## Events

### Eip3009CallbackReceived
```solidity
event Eip3009CallbackReceived(
    address indexed owner,
    uint256 amount,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce,
    uint8 v,
    bytes32 r,
    bytes32 s
);
```

### Permit2CallbackReceived
```solidity
event Permit2CallbackReceived(
    address indexed owner,
    uint256 amount,
    uint256 nonce,
    uint256 deadline,
    bytes signature
);
```

### CallbackFailed
```solidity
event CallbackFailed(string reason);
```

## Example Integration Test Flow

1. **Deploy Contract**
   ```bash
   forge script script/DeployMerchantCallback.s.sol:DeployMerchantCallback \
     --rpc-url $RPC_URL --broadcast
   ```

2. **Store in Database**
   ```sql
   INSERT INTO merchant_callback_contract (...) VALUES (...);
   ```

3. **Create Test Order**
   ```bash
   curl -X POST http://localhost:8080/api/v1/orders \
     -H "Content-Type: application/json" \
     -H "X-API-Key: $API_KEY" \
     -H "X-Timestamp: $(date +%s)" \
     -H "X-Sign: $SIGNATURE" \
     -d '{
       "flow": "ERC20_3009",
       "amount_wei": "1000000",
       "token_symbol": "USDC",
       "chain_id": 97
     }'
   ```

4. **Process Payment**
   (User completes payment via wallet)

5. **Verify Callback**
   ```bash
   # Check callback was received
   cast call $CONTRACT_ADDRESS "getEip3009CallbackCount()" --rpc-url $RPC_URL

   # Get callback details
   cast call $CONTRACT_ADDRESS "getEip3009Callback(uint256)" 0 --rpc-url $RPC_URL
   ```

## Troubleshooting

### Contract Not Receiving Callbacks

1. Verify contract address in database:
   ```sql
   SELECT * FROM merchant_callback_contract WHERE merchant_id = 'your_merchant_id';
   ```

2. Check x402 logs for callback attempts

3. Verify network connectivity

### Callbacks Reverting

1. Check if revert mode is enabled:
   ```bash
   cast call $CONTRACT_ADDRESS "shouldRevert()" --rpc-url $RPC_URL
   ```

2. Review transaction logs for revert reason

## Security Considerations

⚠️ **This is a TEST contract**. For production use:

1. Add access control for callback functions
2. Implement proper business logic
3. Add reentrancy guards if calling external contracts
4. Verify caller address (should be x402 payout contract)
5. Add rate limiting
6. Implement proper error handling and recovery

## Gas Estimates

| Function | Gas Used |
|----------|----------|
| x402SpentEip3009 | ~60,000 |
| x402SpentPermit2 | ~55,000 |
| getEip3009CallbackCount | ~2,300 |
| getPermit2CallbackCount | ~2,300 |

## License

MIT
