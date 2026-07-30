# MerchantCallback Contract

## Product Status

`MerchantCallback` is a reference UUPS receiver for an optional, operator-
provisioned callback transfer flow. It is not required by the current public DIRECT merchant
product, where the payer transfers tokens to the merchant's configured
receiving address.

The internal `topup-service` uses `TopupCallback`, not `MerchantCallback`.
`TopupCallback` has its own EIP-712 domain, omits the `withCalldata`
entrypoints, and verifies the exact balance increase. Its EIP-712 domain is not
used to hash or recover token/Permit2 payment signatures: the supplied
EIP-3009 token or Permit2 contract validates those signatures.

## Deployment Model

`MerchantCallback` is deployed as:

- a `MerchantCallback` implementation; and
- an ERC1967 proxy initialized with the deployer as owner.

Use and register the proxy address. The implementation disables initializers.
The default EIP-712 domain is:

```text
name:    GoatX402 Pay Callback
version: 1
chainId: current callback chain
verifyingContract: proxy address
```

`version()` returns `2.1.0`. The owner can invoke the one-time
`reinitialize(... )` step at reinitializer version `2`, normally as part of a
coordinated upgrade.

## Trust Model

All payment entrypoints use `onlyAuthorized`. The owner controls the
`authorizedCallers` mapping, and an authorized operator caller supplies the
token, Permit2, TSS owner, original payer, amount, and authorization fields.

The contract then pulls tokens into itself:

- EIP-3009 through `receiveWithAuthorization`; or
- Permit2 through `permitTransferFrom`.

The underlying token or Permit2 contract validates the payment authorization.
`MerchantCallback` does not maintain its own token, Permit2, or amount
allowlist.

## Callback ABI

```solidity
function x402SpentEip3009(
    address token,
    address originalPayer,
    address owner,
    uint256 amount,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce,
    uint8 v,
    bytes32 r,
    bytes32 s
) external;

function x402SpentPermit2(
    address permit2,
    address token,
    address originalPayer,
    address owner,
    uint256 amount,
    uint256 nonce,
    uint256 deadline,
    bytes calldata signature
) external;
```

The base callbacks transfer tokens and emit an event. They do **not**
cryptographically bind `originalPayer`; that value is supplied by the
authorized caller for attribution.

The calldata variants add a payer signature:

```solidity
function x402SpentEip3009WithCalldata(
    address token,
    address originalPayer,
    address owner,
    uint256 amount,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce,
    uint8 v,
    bytes32 r,
    bytes32 s,
    bytes calldata calldata_,
    bytes32 orderId,
    uint256 calldataNonce,
    uint256 calldataDeadline,
    uint8 calldataV,
    bytes32 calldataR,
    bytes32 calldataS
) external;

function x402SpentPermit2WithCalldata(
    address permit2,
    address token,
    address originalPayer,
    address owner,
    uint256 amount,
    uint256 nonce,
    uint256 deadline,
    bytes calldata signature,
    bytes calldata calldata_,
    bytes32 orderId,
    uint256 calldataNonce,
    uint256 calldataDeadline,
    uint8 calldataV,
    bytes32 calldataR,
    bytes32 calldataS
) external;
```

## Calldata Signature

The EIP-3009 struct is:

```solidity
Eip3009CallbackData(
    address token,
    address owner,
    address payer,
    uint256 amount,
    bytes32 orderId,
    uint256 calldataNonce,
    uint256 deadline,
    bytes32 calldataHash
)
```

The Permit2 struct prepends `address permit2`:

```solidity
Permit2CallbackData(
    address permit2,
    address token,
    address owner,
    address payer,
    uint256 amount,
    bytes32 orderId,
    uint256 calldataNonce,
    uint256 deadline,
    bytes32 calldataHash
)
```

For both variants the contract:

1. rejects a used `(originalPayer, calldataNonce)`;
2. rejects a deadline earlier than the current block timestamp;
3. hashes the calldata and full payment context;
4. recovers an EOA signer with `ECDSA.recover`;
5. requires that signer to equal `originalPayer`;
6. marks the calldata nonce used;
7. pulls the payment tokens; and
8. performs an internal self-call with the signed calldata.

Any revert before completion rolls the transaction state back, including the
nonce write and token transfer.

## Calldata Execution Semantics

`_executeCalldata` uses:

```solidity
(bool success, bytes memory result) = address(this).call(calldata_);
emit CalldataExecuted(calldata_, success, result);
```

Consequences:

- calldata shorter than four bytes is ignored;
- the call can only reach functions exposed by the proxy's current
  implementation;
- code inside that call sees `msg.sender == address(this)`, not the payer or
  authorized operator caller;
- failure is reported in `CalldataExecuted` and does not revert the completed
  payment; and
- ERC-1271 contract-wallet signatures are not supported.

There is **no selector allowlist**. Solidity comments that mention a selector
whitelist describe behavior that is not implemented by the current contract;
there is no selector mapping or check before the self-call.

The bundled `testCallback(address,uint256,string)` only emits
`TestCallbackExecuted`. It does not verify that its `payer` or `value` arguments
match the payment and should be treated as a demo helper, not production
business logic.

## Administration

```solidity
function setAuthorizedCaller(address caller, bool authorized) external onlyOwner;
function setAuthorizedCallers(
    address[] calldata callers,
    bool[] calldata authorized
) external onlyOwner;
function withdrawTokens(
    address token,
    address to,
    uint256 amount
) external onlyOwner;
function reinitialize(
    string memory eip712Name,
    string memory eip712Version
) public reinitializer(2) onlyOwner;
```

UUPS upgrade authorization is owner-only through `_authorizeUpgrade`.

Useful views:

```solidity
function authorizedCallers(address caller) external view returns (bool);
function calldataNonceUsed(address payer, uint256 nonce) external view returns (bool);
function isCalldataNonceUsed(address payer, uint256 nonce) external view returns (bool);
function getDomainSeparator() external view returns (bytes32);
function owner() external view returns (address);
function version() external pure returns (string memory);
```

There are no callback-history arrays, callback counters, reset functions, or
test revert toggle.

## Events

```solidity
event Eip3009CallbackReceived(
    address indexed token,
    address indexed originalPayer,
    address indexed owner,
    uint256 amount,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce
);

event Permit2CallbackReceived(
    address indexed token,
    address indexed originalPayer,
    address indexed owner,
    uint256 amount,
    uint256 nonce,
    uint256 deadline
);

event Eip3009CallbackWithCalldataReceived(
    address indexed token,
    address indexed originalPayer,
    address indexed owner,
    uint256 amount,
    bytes32 nonce,
    bytes calldata_,
    uint256 calldataNonce
);

event Permit2CallbackWithCalldataReceived(
    address indexed token,
    address indexed originalPayer,
    address indexed owner,
    uint256 amount,
    uint256 nonce,
    bytes calldata_,
    uint256 calldataNonce
);

event CalldataExecuted(bytes calldata_, bool success, bytes result);
event TokensWithdrawn(address indexed token, address indexed to, uint256 amount);
event AuthorizedCallerUpdated(address indexed caller, bool authorized);
event TestCallbackExecuted(address indexed payer, uint256 value, string message);
```

Custom errors:

```solidity
error UnauthorizedCaller(address caller);
error CalldataNonceAlreadyUsed(address user, uint256 nonce);
error CalldataSignatureExpired(uint256 deadline, uint256 currentTime);
error InvalidCalldataSignature(address expected, address actual);
```

## Deploy And Upgrade

Follow [`QUICK_START.md`](QUICK_START.md) for initial deployment and
registration. The canonical source is
[`src/MerchantCallback.sol`](src/MerchantCallback.sol).

Upgrade commands:

```bash
read -r -s PRIVATE_KEY
export PRIVATE_KEY
export PROXY_ADDRESS=0x...

forge script script/DeployMerchantCallback.s.sol:UpgradeMerchantCallback \
  --rpc-url "<rpc>" --broadcast

export EIP712_NAME="GoatX402 Pay Callback"
export EIP712_VERSION="2"
forge script \
  script/DeployMerchantCallback.s.sol:UpgradeMerchantCallbackWithReinit \
  --rpc-url "<rpc>" --broadcast
```

Only the current proxy owner can upgrade. Before broadcasting, test storage
compatibility and coordinate an EIP-712 domain change with every producer and
verifier of calldata signatures.

## Integration Checklist

1. Confirm DELEGATE is enabled for the intended non-public environment.
2. Obtain the exact operator caller for that chain/environment.
3. Deploy and record the ERC1967 proxy address.
4. Confirm `owner()` and `authorizedCallers(operatorCaller)` on-chain.
5. Submit the proxy through the approved operator/merchant configuration flow.
6. Run an end-to-end payment with the environment's real token and Permit2 or
   EIP-3009 configuration.
7. Monitor both payment events and `CalldataExecuted` when calldata is used.
8. Withdraw or account for tokens held by the callback contract.

Do not register the implementation address or copy an old internal database
schema/ABI into a production system.

## Security Notes

- Authorized callers are a strong trust root and must be environment-specific.
- Base callbacks trust the caller-provided `originalPayer` attribution.
- `MerchantCallback` does not verify an exact balance delta; fee-on-transfer or
  malicious tokens can make the emitted amount differ from the amount received.
- Owner compromise permits caller changes, token withdrawals, and upgrades.
- The contract holds tokens received through this callback flow until the owner
  withdraws them.
- Calldata execution is non-atomic with business logic because a failed
  self-call does not revert payment.
- A user signature authorizes bytes, not the safety or correctness of the
  function reached by those bytes.

## Validation

```bash
forge build
forge test --match-contract MerchantCallbackTest -vv
forge test --match-contract TopupCallbackTest -vv
```

The source currently defines 16 MerchantCallback tests and 8 TopupCallback
tests.

## License

The Solidity source files declare SPDX `MIT`. No repository-wide license is
defined by this document.
