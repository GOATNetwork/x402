// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TopupCallback} from "../src/TopupCallback.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title DeployTopupCallback
 * @notice Deployment script for the TopupCallback upgradeable contract
 */
contract DeployTopupCallback is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address authorizedCaller = vm.envOr("AUTHORIZED_CALLER", address(0));

        vm.startBroadcast(deployerPrivateKey);

        TopupCallback implementation = new TopupCallback();
        bytes memory initData =
            abi.encodeWithSelector(bytes4(keccak256("initialize(address,address)")), deployer, authorizedCaller);
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        TopupCallback callback = TopupCallback(address(proxy));

        console.log("===========================================");
        console.log("TopupCallback deployed successfully!");
        console.log("===========================================");
        console.log("Implementation:", address(implementation));
        console.log("Proxy (use this):", address(proxy));
        console.log("Owner:", callback.owner());
        console.log("Authorized caller:", authorizedCaller);
        console.log("Version:", callback.version());
        console.log("Chain ID:", block.chainid);
        console.log("===========================================");

        vm.stopBroadcast();
    }
}
