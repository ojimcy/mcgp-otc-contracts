const hre = require("hardhat");

// Deploy Swap Contract B (McgpEntitlementSwap).
//
// Env:
//   OWNER_ADDRESS         owner / admin (SHOULD be a multisig). Defaults to deployer.
//   MCGP_TOKEN_ADDRESS    MCGP token (default: Sonic mainnet)
//   USDC_TOKEN_ADDRESS    USDC token (default: Sonic mainnet)
//   PREMIUM_BUY_PRICE     USDC (6dp) per MCGP for premium buy   (default 20000 = $0.02)
//   PREMIUM_SELL_PRICE    USDC (6dp) per MCGP for premium sell  (default 18000 = $0.018)
//   LEGACY_SELL_PRICE     USDC (6dp) per MCGP for legacy redeem (default 10000 = $0.01)
//   CHECK_ONLY=1          dry-run: log config, do not deploy.
const PriceKind = { PremiumBuy: 0, PremiumSell: 1, LegacySell: 2 };

async function main() {
  const network = hre.network.name;
  const [deployer] = await hre.ethers.getSigners();

  const owner = process.env.OWNER_ADDRESS || deployer.address;
  const mcgp = process.env.MCGP_TOKEN_ADDRESS || "0x517600323e5E2938207fA2e2e915B9D80e5B2b21";
  const usdc = process.env.USDC_TOKEN_ADDRESS || "0x29219dd400f2Bf60E5a23d13Be72B486D4038894";
  const premiumBuy = BigInt(process.env.PREMIUM_BUY_PRICE || "20000");
  const premiumSell = BigInt(process.env.PREMIUM_SELL_PRICE || "18000");
  const legacySell = BigInt(process.env.LEGACY_SELL_PRICE || "10000");

  console.log(`\nDeploying McgpEntitlementSwap (Swap Contract B) to ${network}`);
  console.log("=".repeat(60));
  console.log("Deployer:    ", deployer.address);
  console.log("Owner:       ", owner, owner === deployer.address ? "(deployer — set a MULTISIG for prod!)" : "");
  console.log("MCGP:        ", mcgp);
  console.log("USDC:        ", usdc);
  console.log("Premium buy: ", premiumBuy.toString(), `($${Number(premiumBuy) / 1e6}/MCGP)`);
  console.log("Premium sell:", premiumSell.toString(), `($${Number(premiumSell) / 1e6}/MCGP)`);
  console.log("Legacy sell: ", legacySell.toString(), `($${Number(legacySell) / 1e6}/MCGP)`);

  if (process.env.CHECK_ONLY === "1") {
    console.log("\nCHECK_ONLY=1 — dry run, not deploying.");
    return;
  }

  const Swap = await hre.ethers.getContractFactory("McgpEntitlementSwap");
  const swap = await Swap.deploy(owner, mcgp, usdc);
  await swap.waitForDeployment();
  const address = await swap.getAddress();
  console.log("\nDeployed to:", address);

  // Seed one phase per kind (active index 0). Run by deployer; if owner is a
  // multisig, instead submit these as multisig txs after transferring nothing
  // (owner is already the multisig — these calls must come FROM the owner).
  if (owner === deployer.address) {
    console.log("\nConfiguring initial price phases...");
    await (await swap.addPhase(PriceKind.PremiumBuy, premiumBuy, "premium buy")).wait();
    await (await swap.addPhase(PriceKind.PremiumSell, premiumSell, "premium sell")).wait();
    await (await swap.addPhase(PriceKind.LegacySell, legacySell, "legacy redeem")).wait();
    console.log("Phases configured.");
  } else {
    console.log("\nOwner is not the deployer — submit addPhase() calls from the multisig:");
    console.log(`  addPhase(${PriceKind.PremiumBuy}, ${premiumBuy}, "premium buy")`);
    console.log(`  addPhase(${PriceKind.PremiumSell}, ${premiumSell}, "premium sell")`);
    console.log(`  addPhase(${PriceKind.LegacySell}, ${legacySell}, "legacy redeem")`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("Next steps:");
  console.log("  1. seedLegacy(users, amounts) from the pre-launch snapshot.");
  console.log("  2. approve + fund(MCGP, amount) to back premium buys.");
  console.log("  3. approve + fund(USDC, amount) for redemption float.");
  console.log(`  4. Wire MCGP_SWAP_B_ADDRESS=${address} into tsa-api-go.`);

  if (network !== "hardhat" && network !== "localhost") {
    console.log(`\nVerify:\n  npx hardhat verify --network ${network} ${address} ${owner} ${mcgp} ${usdc}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
