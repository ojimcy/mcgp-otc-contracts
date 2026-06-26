const hre = require("hardhat");

// Full Sonic-testnet bring-up for McgpEntitlementSwap (Swap Contract B v2).
// Deploys mock MCGP + USDC, deploys the swap, configures phases/operator/
// guardian/caps, and funds it so the IT credit/debit/settle path is testable.
//
// On testnet the deployer is used as owner + operator + guardian so a single
// key can exercise every flow. On mainnet use scripts/deploy-entitlement-swap.js
// with a multisig OWNER_ADDRESS instead.
const PriceKind = { PremiumBuy: 0, PremiumSell: 1, LegacySell: 2 };
const mcgp = (n) => hre.ethers.parseUnits(String(n), 18);
const usdc = (n) => hre.ethers.parseUnits(String(n), 6);

async function main() {
  const net = hre.network.name;
  const [deployer] = await hre.ethers.getSigners();
  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`\nMcgpEntitlementSwap testnet bring-up → ${net}`);
  console.log("=".repeat(60));
  console.log("Deployer:", deployer.address, `(${hre.ethers.formatEther(bal)} S)`);
  if (bal === 0n) throw new Error("Deployer has no gas");

  // 1. Mock tokens
  const ERC20Mock = await hre.ethers.getContractFactory("contracts/mocks/ERC20Mock.sol:ERC20Mock");
  const mcgpToken = await ERC20Mock.deploy("MCGP Token (test)", "MCGP", 18);
  await mcgpToken.waitForDeployment();
  const usdcToken = await ERC20Mock.deploy("USD Coin (test)", "USDC", 6);
  await usdcToken.waitForDeployment();
  const mcgpAddr = await mcgpToken.getAddress();
  const usdcAddr = await usdcToken.getAddress();
  console.log("Mock MCGP:", mcgpAddr);
  console.log("Mock USDC:", usdcAddr);

  // 2. Swap (deployer = owner)
  const Swap = await hre.ethers.getContractFactory("McgpEntitlementSwap");
  const swap = await Swap.deploy(deployer.address, mcgpAddr, usdcAddr);
  await swap.waitForDeployment();
  const swapAddr = await swap.getAddress();
  console.log("Swap:", swapAddr);

  // 3. Price phases (defaults: $0.02 buy / $0.018 sell / $0.01 legacy)
  await (await swap.addPhase(PriceKind.PremiumBuy, 20000, "premium buy")).wait();
  await (await swap.addPhase(PriceKind.PremiumSell, 18000, "premium sell")).wait();
  await (await swap.addPhase(PriceKind.LegacySell, 10000, "legacy redeem")).wait();
  console.log("Phases set: buy=20000 sell=18000 legacy=10000");

  // 4. Roles (deployer plays operator + guardian on testnet)
  await (await swap.addOperator(deployer.address)).wait();
  await (await swap.addGuardian(deployer.address)).wait();
  console.log("Operator + guardian = deployer");

  // 5. Credit caps: min 1 MCGP, 100k per tx, 1M per rolling day
  await (await swap.setCreditCaps(mcgp(1), mcgp(100_000), 86_400, mcgp(1_000_000))).wait();
  console.log("Credit caps: min=1 perTx=100k window=1d cap=1M");

  // 6. Mint + fund: 1M MCGP backing, 100k USDC float
  await (await mcgpToken.mint(deployer.address, mcgp(2_000_000))).wait();
  await (await usdcToken.mint(deployer.address, usdc(200_000))).wait();
  await (await mcgpToken.approve(swapAddr, mcgp(1_000_000))).wait();
  await (await swap.fund(mcgpAddr, mcgp(1_000_000))).wait();
  await (await usdcToken.approve(swapAddr, usdc(100_000))).wait();
  await (await swap.fund(usdcAddr, usdc(100_000))).wait();
  const [held, owed] = await swap.backing();
  console.log(`Funded. backing held=${hre.ethers.formatUnits(held, 18)} MCGP owed=${hre.ethers.formatUnits(owed, 18)} MCGP`);

  console.log("\n" + "=".repeat(60));
  console.log("Addresses:");
  console.log("  MCGP_TOKEN_ADDRESS =", mcgpAddr);
  console.log("  USDC_TOKEN_ADDRESS =", usdcAddr);
  console.log("  MCGP_SWAP_B_ADDRESS =", swapAddr);
  console.log("\nVerify swap:");
  console.log(`  npx hardhat verify --network ${net} ${swapAddr} ${deployer.address} ${mcgpAddr} ${usdcAddr}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
