// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MerchantCallback} from "../src/MerchantCallback.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title DeployMerchantCallback
 * @notice Deployment script for MerchantCallback upgradeable contract
 * @dev Deploys implementation + ERC1967 proxy (UUPS pattern)
 *
 * Usage:
 *   Local: forge script script/DeployMerchantCallback.s.sol:DeployMerchantCallback --rpc-url http://localhost:8545 --broadcast
 *   BSC Testnet: forge script script/DeployMerchantCallback.s.sol:DeployMerchantCallback --rpc-url bsc_testnet --broadcast --verify
 *   GOAT Testnet: forge script script/DeployMerchantCallback.s.sol:DeployMerchantCallback --rpc-url goat_testnet3 --broadcast
 */
contract DeployMerchantCallback is Script {
    function run() external {
        // Get deployer private key from environment variable
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        // Start broadcasting transactions
        vm.startBroadcast(deployerPrivateKey);

        // Deploy implementation contract
        MerchantCallback implementation = new MerchantCallback();

        // Prepare initialization data
        bytes memory initData = abi.encodeWithSelector(
            MerchantCallback.initialize.selector,
            deployer  // initial owner
        );

        // Deploy proxy pointing to implementation
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);

        // Get the proxy address as MerchantCallback
        MerchantCallback callback = MerchantCallback(address(proxy));

        // Optionally authorize the x402 caller (e.g. the platform "Bob" address)
        // in the SAME broadcast. Signing happens with the env-provided key inside
        // forge, so the key is never placed on a `cast` command line (argv), unlike
        // a follow-up shell `cast send --private-key`.
        address x402Caller = vm.envOr("X402_CALLER_ADDRESS", address(0));
        if (x402Caller != address(0)) {
            callback.setAuthorizedCaller(x402Caller, true);
        }

        console.log("===========================================");
        console.log("MerchantCallback deployed successfully!");
        console.log("===========================================");
        console.log("Implementation:", address(implementation));
        console.log("Proxy (use this):", address(proxy));
        console.log("Owner:", callback.owner());
        console.log("Version:", callback.version());
        console.log("Chain ID:", block.chainid);
        if (x402Caller != address(0)) {
            console.log("Authorized x402 caller:", x402Caller);
        }
        console.log("===========================================");

        // Stop broadcasting
        vm.stopBroadcast();
    }
}

/**
 * @title UpgradeMerchantCallback
 * @notice Upgrade script for MerchantCallback
 * @dev Deploys new implementation and upgrades proxy
 *
 * Usage:
 *   Set PROXY_ADDRESS env var to existing proxy address
 *   forge script script/DeployMerchantCallback.s.sol:UpgradeMerchantCallback --rpc-url <rpc> --broadcast
 */
contract UpgradeMerchantCallback is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address proxyAddress = vm.envAddress("PROXY_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        // Deploy new implementation
        MerchantCallback newImplementation = new MerchantCallback();

        // Get proxy as MerchantCallback and upgrade
        MerchantCallback callback = MerchantCallback(proxyAddress);
        callback.upgradeToAndCall(address(newImplementation), "");

        console.log("===========================================");
        console.log("MerchantCallback upgraded successfully!");
        console.log("===========================================");
        console.log("Proxy:", proxyAddress);
        console.log("New Implementation:", address(newImplementation));
        console.log("Version:", callback.version());
        console.log("===========================================");

        vm.stopBroadcast();
    }
}

/**
 * @title UpgradeMerchantCallbackWithReinit
 * @notice Upgrade script for MerchantCallback with EIP712 domain reinitialization
 * @dev Deploys new implementation, upgrades proxy, and reinitializes EIP712 domain
 *
 * Usage:
 *   Set PROXY_ADDRESS, EIP712_NAME, EIP712_VERSION env vars
 *   forge script script/DeployMerchantCallback.s.sol:UpgradeMerchantCallbackWithReinit --rpc-url <rpc> --broadcast
 */
contract UpgradeMerchantCallbackWithReinit is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address proxyAddress = vm.envAddress("PROXY_ADDRESS");
        string memory eip712Name = vm.envString("EIP712_NAME");
        string memory eip712Version = vm.envString("EIP712_VERSION");

        vm.startBroadcast(deployerPrivateKey);

        // Deploy new implementation
        MerchantCallback newImplementation = new MerchantCallback();

        // Get proxy as MerchantCallback and upgrade with reinitialize call
        MerchantCallback callback = MerchantCallback(proxyAddress);
        bytes memory reinitData = abi.encodeWithSelector(
            MerchantCallback.reinitialize.selector,
            eip712Name,
            eip712Version
        );
        callback.upgradeToAndCall(address(newImplementation), reinitData);

        console.log("===========================================");
        console.log("MerchantCallback upgraded with reinit!");
        console.log("===========================================");
        console.log("Proxy:", proxyAddress);
        console.log("New Implementation:", address(newImplementation));
        console.log("Version:", callback.version());
        console.log("EIP712 Name:", eip712Name);
        console.log("EIP712 Version:", eip712Version);
        console.log("===========================================");

        vm.stopBroadcast();
    }
}
