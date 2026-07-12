// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TopupCallback} from "../src/TopupCallback.sol";
import {ERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract MockTopupEip3009Token is ERC20 {
    mapping(bytes32 => bool) public authorizationUsed;

    constructor() ERC20("Mock USDC", "USDC") {
        _mint(msg.sender, 1000000e6);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8,
        bytes32,
        bytes32
    ) public virtual {
        require(block.timestamp >= validAfter, "Authorization not yet valid");
        require(block.timestamp < validBefore, "Authorization expired");
        require(!authorizationUsed[nonce], "Authorization already used");

        authorizationUsed[nonce] = true;
        _transfer(from, to, value);
    }
}

contract MockShortTransferTopupEip3009Token is MockTopupEip3009Token {
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
    ) public override {
        super.receiveWithAuthorization(from, to, value - 1, validAfter, validBefore, nonce, v, r, s);
    }
}

contract MockTopupPermit2 {
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

    mapping(uint256 => bool) public nonceUsed;

    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata
    ) public virtual {
        require(block.timestamp <= permit.deadline, "Permit expired");
        require(!nonceUsed[permit.nonce], "Nonce already used");

        nonceUsed[permit.nonce] = true;
        require(
            IERC20(permit.permitted.token).transferFrom(owner, transferDetails.to, transferDetails.requestedAmount),
            "Transfer failed"
        );
    }
}

contract MockShortTransferPermit2 is MockTopupPermit2 {
    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata
    ) public override {
        require(block.timestamp <= permit.deadline, "Permit expired");
        require(!nonceUsed[permit.nonce], "Nonce already used");

        nonceUsed[permit.nonce] = true;
        require(
            IERC20(permit.permitted.token).transferFrom(owner, transferDetails.to, transferDetails.requestedAmount - 1),
            "Transfer failed"
        );
    }
}

contract TopupCallbackTest is Test {
    TopupCallback public callback;
    MockTopupEip3009Token public token;
    MockTopupPermit2 public permit2;

    address public owner;
    address public authorizedCaller;
    address public tssWallet;
    address public user;

    function setUp() public {
        owner = address(this);
        authorizedCaller = address(0x7770000000000000000000000000000000000001);
        tssWallet = address(0x7550000000000000000000000000000000000001);
        user = address(0x1234);

        TopupCallback implementation = new TopupCallback();
        bytes memory initData =
            abi.encodeWithSelector(bytes4(keccak256("initialize(address,address)")), owner, authorizedCaller);
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        callback = TopupCallback(address(proxy));

        token = new MockTopupEip3009Token();
        permit2 = new MockTopupPermit2();

        token.mint(tssWallet, 1000000e6);

        vm.prank(tssWallet);
        token.approve(address(permit2), type(uint256).max);
    }

    function _computeDomainSeparator(string memory name, string memory version_) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version_)),
                block.chainid,
                address(callback)
            )
        );
    }

    function testEip3009CallbackPullsFundsIntoTopupCallback() public {
        uint256 amount = 1000e6;
        uint256 validAfter = block.timestamp;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256(abi.encodePacked("topup_nonce_1"));

        vm.prank(authorizedCaller);
        callback.x402SpentEip3009(
            address(token),
            user,
            tssWallet,
            amount,
            validAfter,
            validBefore,
            nonce,
            27,
            keccak256(abi.encodePacked("r_value")),
            keccak256(abi.encodePacked("s_value"))
        );

        assertEq(token.balanceOf(address(callback)), amount);
        assertEq(token.balanceOf(tssWallet), 1000000e6 - amount);
    }

    function testPermit2CallbackPullsFundsIntoTopupCallback() public {
        uint256 amount = 2500e6;
        uint256 nonce = 42;
        uint256 deadline = block.timestamp + 1 hours;

        vm.prank(authorizedCaller);
        callback.x402SpentPermit2(address(permit2), address(token), user, tssWallet, amount, nonce, deadline, hex"1234");

        assertEq(token.balanceOf(address(callback)), amount);
        assertEq(token.balanceOf(tssWallet), 1000000e6 - amount);
    }

    function testEip3009CallbackRevertsWhenReceivedAmountIsShort() public {
        MockShortTransferTopupEip3009Token shortToken = new MockShortTransferTopupEip3009Token();
        shortToken.mint(tssWallet, 1000000e6);

        uint256 amount = 1000e6;
        uint256 validAfter = block.timestamp;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256(abi.encodePacked("topup_nonce_short"));

        vm.expectRevert(abi.encodeWithSelector(TopupCallback.AmountMismatch.selector, amount, amount - 1));
        vm.prank(authorizedCaller);
        callback.x402SpentEip3009(
            address(shortToken),
            user,
            tssWallet,
            amount,
            validAfter,
            validBefore,
            nonce,
            27,
            keccak256(abi.encodePacked("r_value")),
            keccak256(abi.encodePacked("s_value"))
        );
    }

    function testPermit2CallbackRevertsWhenReceivedAmountIsShort() public {
        MockShortTransferPermit2 shortPermit2 = new MockShortTransferPermit2();

        vm.prank(tssWallet);
        token.approve(address(shortPermit2), type(uint256).max);

        uint256 amount = 2500e6;
        uint256 nonce = 43;
        uint256 deadline = block.timestamp + 1 hours;

        vm.expectRevert(abi.encodeWithSelector(TopupCallback.AmountMismatch.selector, amount, amount - 1));
        vm.prank(authorizedCaller);
        callback.x402SpentPermit2(
            address(shortPermit2), address(token), user, tssWallet, amount, nonce, deadline, hex"1234"
        );
    }

    function testWithdrawTokensRevertsForZeroTokenAddress() public {
        vm.expectRevert(TopupCallback.ZeroAddressToken.selector);
        callback.withdrawTokens(address(0), user, 1);
    }

    function testWithdrawTokensRevertsForZeroRecipient() public {
        vm.expectRevert(TopupCallback.ZeroAddressRecipient.selector);
        callback.withdrawTokens(address(token), address(0), 1);
    }

    function testUsesTopupSpecificEip712Domain() public view {
        bytes32 expected = _computeDomainSeparator("GoatX402 Topup Callback", "1");
        assertEq(callback.getDomainSeparator(), expected);
    }

    function testInitializerSetsAuthorizedCaller() public view {
        assertTrue(callback.authorizedCallers(authorizedCaller));
    }
}
