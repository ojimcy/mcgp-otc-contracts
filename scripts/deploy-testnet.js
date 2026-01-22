const hre = require("hardhat");

async function main() {
    const network = hre.network.name;
    console.log(`\nDeploying Mock Tokens and OtcMarketplace to ${network}...`);
    console.log("=".repeat(50));

    // Get deployer info
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deployer:", deployer.address);

    const balance = await hre.ethers.provider.getBalance(deployer.address);
    console.log("Balance:", hre.ethers.formatEther(balance), "S");

    // Deploy mock MCGP token
    console.log("\n1. Deploying Mock MCGP Token...");
    const ERC20Mock = await hre.ethers.getContractFactory("contracts/mocks/ERC20Mock.sol:ERC20Mock");
    const mcgpToken = await ERC20Mock.deploy("MCGP Token", "MCGP", 18);
    await mcgpToken.waitForDeployment();
    const mcgpAddress = await mcgpToken.getAddress();
    console.log("   Mock MCGP deployed to:", mcgpAddress);

    // Deploy mock USDC token
    console.log("\n2. Deploying Mock USDC Token...");
    const usdcToken = await ERC20Mock.deploy("USD Coin", "USDC", 6);
    await usdcToken.waitForDeployment();
    const usdcAddress = await usdcToken.getAddress();
    console.log("   Mock USDC deployed to:", usdcAddress);

    // Deploy OtcMarketplace
    console.log("\n3. Deploying OtcMarketplace...");
    const OtcMarketplace = await hre.ethers.getContractFactory("OtcMarketplace");
    const marketplace = await OtcMarketplace.deploy(mcgpAddress, usdcAddress);
    await marketplace.waitForDeployment();
    const marketplaceAddress = await marketplace.getAddress();
    console.log("   OtcMarketplace deployed to:", marketplaceAddress);

    // Mint tokens to deployer for testing
    console.log("\n4. Minting test tokens...");
    const mcgpAmount = hre.ethers.parseUnits("1000000", 18); // 1M MCGP
    const usdcAmount = hre.ethers.parseUnits("1000000", 6);  // 1M USDC

    await mcgpToken.mint(deployer.address, mcgpAmount);
    console.log("   Minted 1,000,000 MCGP to deployer");

    await usdcToken.mint(deployer.address, usdcAmount);
    console.log("   Minted 1,000,000 USDC to deployer");

    // Fund the marketplace
    console.log("\n5. Funding marketplace...");
    const fundMcgp = hre.ethers.parseUnits("100000", 18); // 100K MCGP
    const fundUsdc = hre.ethers.parseUnits("100000", 6);  // 100K USDC

    await mcgpToken.approve(marketplaceAddress, fundMcgp);
    await marketplace.fund(mcgpAddress, fundMcgp);
    console.log("   Funded with 100,000 MCGP");

    await usdcToken.approve(marketplaceAddress, fundUsdc);
    await marketplace.fund(usdcAddress, fundUsdc);
    console.log("   Funded with 100,000 USDC");

    // Display contract state
    const buyPhases = await marketplace.getBuyPhases();
    const sellPhases = await marketplace.getSellPhases();
    const balances = await marketplace.getBalances();

    console.log("\n" + "=".repeat(50));
    console.log("DEPLOYMENT COMPLETE");
    console.log("=".repeat(50));

    console.log("\n=== Contract Addresses ===");
    console.log("Mock MCGP Token:", mcgpAddress);
    console.log("Mock USDC Token:", usdcAddress);
    console.log("OtcMarketplace: ", marketplaceAddress);

    console.log("\n=== Marketplace Balances ===");
    console.log("MCGP:", hre.ethers.formatUnits(balances.mcgpBalance, 18));
    console.log("USDC:", hre.ethers.formatUnits(balances.usdcBalance, 6));

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

    // Verification commands
    console.log("\n" + "=".repeat(50));
    console.log("VERIFICATION COMMANDS");
    console.log("=".repeat(50));
    console.log(`\nnpx hardhat verify --network ${network} ${mcgpAddress} "MCGP Token" "MCGP" 18`);
    console.log(`npx hardhat verify --network ${network} ${usdcAddress} "USD Coin" "USDC" 6`);
    console.log(`npx hardhat verify --network ${network} ${marketplaceAddress} ${mcgpAddress} ${usdcAddress}`);

    return {
        mcgpToken: mcgpAddress,
        usdcToken: usdcAddress,
        marketplace: marketplaceAddress,
    };
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
