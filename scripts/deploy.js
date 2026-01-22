const hre = require("hardhat");

async function main() {
    const network = hre.network.name;
    console.log(`\nDeploying OtcMarketplace to ${network}...`);
    console.log("=".repeat(50));

    // Get deployer info
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deployer:", deployer.address);

    const balance = await hre.ethers.provider.getBalance(deployer.address);
    console.log("Balance:", hre.ethers.formatEther(balance), "ETH");

    // Get token addresses from environment or use defaults (Sonic mainnet)
    const MCGP_TOKEN_ADDRESS = process.env.MCGP_TOKEN_ADDRESS || "0x517600323e5E2938207fA2e2e915B9D80e5B2b21";
    const USDC_TOKEN_ADDRESS = process.env.USDC_TOKEN_ADDRESS || "0x29219dd400f2Bf60E5a23d13Be72B486D4038894";

    console.log("\nToken Addresses:");
    console.log("  MCGP:", MCGP_TOKEN_ADDRESS);
    console.log("  USDC:", USDC_TOKEN_ADDRESS);

    // Deploy the contract
    console.log("\nDeploying contract...");
    const OtcMarketplace = await hre.ethers.getContractFactory("OtcMarketplace");
    const marketplace = await OtcMarketplace.deploy(MCGP_TOKEN_ADDRESS, USDC_TOKEN_ADDRESS);

    await marketplace.waitForDeployment();
    const address = await marketplace.getAddress();

    console.log("\nOtcMarketplace deployed to:", address);

    // Get initial phase info
    const buyPhases = await marketplace.getBuyPhases();
    const sellPhases = await marketplace.getSellPhases();
    const isPaused = await marketplace.paused();

    console.log("\n=== Contract State ===");
    console.log("Paused:", isPaused);
    console.log("Owner:", await marketplace.owner());

    console.log("\n=== Buy Phases ===");
    buyPhases.forEach((phase, index) => {
        const priceUsd = Number(phase.price) / 1e6;
        console.log(`  [${index}] ${phase.name.padEnd(12)} $${priceUsd.toFixed(6)}/MCGP ${phase.isActive ? "(ACTIVE)" : ""}`);
    });

    console.log("\n=== Sell Phases ===");
    sellPhases.forEach((phase, index) => {
        const priceUsd = Number(phase.price) / 1e6;
        console.log(`  [${index}] ${phase.name.padEnd(12)} $${priceUsd.toFixed(6)}/MCGP ${phase.isActive ? "(ACTIVE)" : ""}`);
    });

    // Output for .env
    console.log("\n" + "=".repeat(50));
    console.log("Add to your .env file:");
    console.log(`OTC_MARKETPLACE_ADDRESS=${address}`);

    // Verification command
    if (network !== "hardhat" && network !== "localhost") {
        console.log("\n" + "=".repeat(50));
        console.log("To verify on block explorer, run:");
        console.log(`npx hardhat verify --network ${network} ${address} ${MCGP_TOKEN_ADDRESS} ${USDC_TOKEN_ADDRESS}`);
    }

    console.log("\n=== Next Steps ===");
    console.log("1. Approve MCGP tokens: mcgpToken.approve(marketplaceAddress, amount)");
    console.log("2. Fund with MCGP: marketplace.fund(mcgpTokenAddress, amount)");
    console.log("3. Approve USDC tokens: usdcToken.approve(marketplaceAddress, amount)");
    console.log("4. Fund with USDC: marketplace.fund(usdcTokenAddress, amount)");
    console.log("5. Update frontend with new contract address");

    return { address, mcgpToken: MCGP_TOKEN_ADDRESS, usdcToken: USDC_TOKEN_ADDRESS };
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
