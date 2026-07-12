// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ITopupEip3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

interface ITopupPermit2 {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

/**
 * @title TopupCallback
 * @notice Dedicated callback contract for topup-service settlements
 * @dev Unlike MerchantCallback, this contract intentionally does not expose
 *      any calldata execution / withCalldata callback entrypoints.
 */
contract TopupCallback is Initializable, OwnableUpgradeable, EIP712Upgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    string public constant DEFAULT_EIP712_NAME = "GoatX402 Topup Callback";
    string public constant DEFAULT_EIP712_VERSION = "1";

    mapping(address => bool) public authorizedCallers;

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

    event TokensWithdrawn(address indexed token, address indexed to, uint256 amount);
    event AuthorizedCallerUpdated(address indexed caller, bool authorized);

    error AmountMismatch(uint256 expected, uint256 actual);
    error UnauthorizedCaller(address caller);
    error ZeroAddressToken();
    error ZeroAddressRecipient();

    modifier onlyAuthorized() {
        if (!authorizedCallers[msg.sender]) {
            revert UnauthorizedCaller(msg.sender);
        }
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner, address initialAuthorizedCaller) public initializer {
        __Ownable_init(initialOwner);
        __EIP712_init(DEFAULT_EIP712_NAME, DEFAULT_EIP712_VERSION);
        if (initialAuthorizedCaller != address(0)) {
            authorizedCallers[initialAuthorizedCaller] = true;
            emit AuthorizedCallerUpdated(initialAuthorizedCaller, true);
        }
    }

    function reinitialize(string memory eip712Name, string memory eip712Version) public reinitializer(2) onlyOwner {
        __EIP712_init(eip712Name, eip712Version);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        authorizedCallers[caller] = authorized;
        emit AuthorizedCallerUpdated(caller, authorized);
    }

    function setAuthorizedCallers(address[] calldata callers, bool[] calldata authorized) external onlyOwner {
        require(callers.length == authorized.length, "Length mismatch");
        for (uint256 i = 0; i < callers.length; i++) {
            authorizedCallers[callers[i]] = authorized[i];
            emit AuthorizedCallerUpdated(callers[i], authorized[i]);
        }
    }

    function withdrawTokens(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddressToken();
        if (to == address(0)) revert ZeroAddressRecipient();
        IERC20(token).safeTransfer(to, amount);
        emit TokensWithdrawn(token, to, amount);
    }

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
    ) external onlyAuthorized {
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));

        ITopupEip3009(token)
            .receiveWithAuthorization(owner, address(this), amount, validAfter, validBefore, nonce, v, r, s);

        _requireExactAmountReceived(token, balanceBefore, amount);

        emit Eip3009CallbackReceived(token, originalPayer, owner, amount, validAfter, validBefore, nonce);
    }

    function x402SpentPermit2(
        address permit2,
        address token,
        address originalPayer,
        address owner,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyAuthorized {
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));

        ITopupPermit2(permit2)
            .permitTransferFrom(
                ITopupPermit2.PermitTransferFrom({
                permitted: ITopupPermit2.TokenPermissions({token: token, amount: amount}),
                nonce: nonce,
                deadline: deadline
            }),
                ITopupPermit2.SignatureTransferDetails({to: address(this), requestedAmount: amount}),
                owner,
                signature
            );

        _requireExactAmountReceived(token, balanceBefore, amount);

        emit Permit2CallbackReceived(token, originalPayer, owner, amount, nonce, deadline);
    }

    function _requireExactAmountReceived(address token, uint256 balanceBefore, uint256 expectedAmount) private view {
        uint256 balanceAfter = IERC20(token).balanceOf(address(this));
        uint256 actualAmount = balanceAfter >= balanceBefore ? balanceAfter - balanceBefore : 0;
        if (actualAmount != expectedAmount) {
            revert AmountMismatch(expectedAmount, actualAmount);
        }
    }

    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function version() external pure returns (string memory) {
        return "1.0.0";
    }
}
