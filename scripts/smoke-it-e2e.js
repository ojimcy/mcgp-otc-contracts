// Full on-chain E2E for McgpEntitlementSwap v2 — runs on the in-process Hardhat
// network. Drives the entire lifecycle, replicating the exact calls the Go
// backend makes (user-signed buy/spend/sell/withdraw/legacy + the operator
// IT path credit/debit/settle/reverse), asserting the backing invariant and
// the C1 (credited-not-self-exitable) / C2 (two-phase) properties at each step.
//
// Run: npx hardhat run scripts/smoke-it-e2e.js
const { ethers } = require("hardhat");
const assert = require("assert");

const PREMIUM_BUY = 0, PREMIUM_SELL = 1, LEGACY_SELL = 2;
const mcgp = (n) => ethers.parseUnits(String(n), 18);
const usdc = (n) => ethers.parseUnits(String(n), 6);
const refOf = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
let step = 0;
const log = (m) => console.log(`  [${String(++step).padStart(2, "0")}] ${m}`);

async function main() {
  const [owner, operator, guardian, alice, bob, merchant] = await ethers.getSigners();
  const ERC20Mock = await ethers.getContractFactory("contracts/mocks/ERC20Mock.sol:ERC20Mock");
  const mcgpToken = await ERC20Mock.deploy("MCGP", "MCGP", 18); await mcgpToken.waitForDeployment();
  const usdcToken = await ERC20Mock.deploy("USDC", "USDC", 6); await usdcToken.waitForDeployment();
  const Swap = await ethers.getContractFactory("McgpEntitlementSwap");
  const swap = await Swap.deploy(owner.address, await mcgpToken.getAddress(), await usdcToken.getAddress());
  await swap.waitForDeployment();
  const A = await swap.getAddress();
  console.log(`\nMcgpEntitlementSwap @ ${A}\n${"=".repeat(60)}`);

  // Config: phases, operator, guardian, caps.
  await (await swap.addPhase(PREMIUM_BUY, 20000, "buy $0.02")).wait();
  await (await swap.addPhase(PREMIUM_SELL, 18000, "sell $0.018")).wait();
  await (await swap.addPhase(LEGACY_SELL, 10000, "legacy $0.01")).wait();
  await (await swap.addOperator(operator.address)).wait();
  await (await swap.addGuardian(guardian.address)).wait();
  await (await swap.setCreditCaps(mcgp(1), mcgp(100000), 3600, mcgp(1000000))).wait();
  log("configured phases + operator + guardian + caps");

  // Mint + fund.
  await (await mcgpToken.mint(owner.address, mcgp(10_000_000))).wait();
  await (await usdcToken.mint(owner.address, usdc(10_000_000))).wait();
  await (await usdcToken.mint(alice.address, usdc(1_000_000))).wait();
  await (await mcgpToken.mint(alice.address, mcgp(5000))).wait(); // alice's legacy wallet MCGP
  await (await mcgpToken.approve(A, mcgp(1_000_000))).wait();
  await (await swap.fund(await mcgpToken.getAddress(), mcgp(100_000))).wait(); // premium/IT backing
  await (await usdcToken.approve(A, usdc(1_000_000))).wait();
  await (await swap.fund(await usdcToken.getAddress(), usdc(500_000))).wait(); // redemption float
  log("funded 100k MCGP backing + 500k USDC float");

  const assertBacking = async (label) => {
    const [held, owed] = await swap.backing();
    assert(held >= owed, `${label}: backing broken held=${held} owed=${owed}`);
  };
  await assertBacking("post-fund");

  // ── USDC path (user-signed) ──────────────────────────────────────────────
  let cost = await swap.quote(PREMIUM_BUY, mcgp(1000));
  await (await usdcToken.connect(alice).approve(A, cost)).wait();
  await (await swap.connect(alice).buyPremium(mcgp(1000), cost)).wait();
  assert((await swap.premiumBought(alice.address)) === mcgp(1000), "buy bought");
  log(`alice buyPremium 1000 MCGP for $${Number(cost) / 1e6} USDC`);
  await assertBacking("after buy");

  await (await swap.connect(alice).spend(merchant.address, mcgp(300), refOf("order-1"))).wait();
  assert((await swap.premiumBought(merchant.address)) === mcgp(300), "spend bought->merchant");
  log("alice spend 300 MCGP (bought) -> merchant");

  await (await swap.connect(alice).sellPremium(mcgp(200), 0)).wait();
  log("alice sellPremium 200 MCGP -> USDC");
  await (await swap.connect(alice).withdrawPremiumToWallet(mcgp(100))).wait();
  log("alice withdrawPremiumToWallet 100 MCGP (now plain wallet MCGP)");
  assert((await swap.premiumBought(alice.address)) === mcgp(400), "alice bought 400 left");
  await assertBacking("after sell+withdraw");

  // Legacy redeem-only.
  await (await swap.seedLegacy([alice.address], [mcgp(2000)])).wait();
  await (await mcgpToken.connect(alice).approve(A, mcgp(2000))).wait();
  await (await swap.connect(alice).sellLegacy(mcgp(1500), 0)).wait();
  assert((await swap.legacyRemaining(alice.address)) === mcgp(500), "legacy remaining 500");
  let reverted = false;
  try { await swap.connect(alice).sellLegacy(mcgp(600), 0); } catch { reverted = true; }
  assert(reverted, "legacy beyond entitlement must revert");
  log("alice sellLegacy 1500 (cap 2000); 600 over-cap correctly reverted");

  // ── IT operator path (mimics the Go backend) ─────────────────────────────
  const creditRef = refOf("IT:credit:" + "intent-bob-1");
  await (await swap.connect(operator).creditPremium(bob.address, mcgp(500), creditRef)).wait();
  assert((await swap.premiumCredited(bob.address)) === mcgp(500), "IT credit");
  log("operator creditPremium 500 MCGP (NGN buy) -> bob.premiumCredited");
  await assertBacking("after IT credit");

  // C1: credited premium cannot be self-exited.
  let c1a = false, c1b = false;
  try { await swap.connect(bob).withdrawPremiumToWallet(mcgp(1)); } catch { c1a = true; }
  try { await swap.connect(bob).sellPremium(mcgp(1), 0); } catch { c1b = true; }
  assert(c1a && c1b, "C1: credited must NOT be withdrawable/sellable");
  log("C1 verified: bob cannot withdraw/sell credited premium (spend-only)");

  // bob spends credited -> merchant receives credited (still non-exitable).
  await (await swap.connect(bob).spend(merchant.address, mcgp(100), refOf("order-2"))).wait();
  assert((await swap.premiumCredited(merchant.address)) === mcgp(100), "credited spend preserves bucket");
  let c1c = false;
  try { await swap.connect(merchant).withdrawPremiumToWallet(mcgp(1)); } catch { c1c = true; }
  // merchant has 300 bought (withdrawable) + 100 credited; withdraw of 1 succeeds from bought,
  // so instead assert merchant cannot withdraw MORE than its bought (provenance holds).
  let c1d = false;
  try { await swap.connect(merchant).withdrawPremiumToWallet(mcgp(301)); } catch { c1d = true; }
  assert(c1d, "C1: merchant cannot withdraw beyond its bought bucket");
  log("C1 verified: spent-credited stays non-exitable for the recipient");

  // IT sell two-phase: debit -> settle (and a separate debit -> reverse).
  const debitRef = refOf("IT:debit:" + "intent-bob-sell-1");
  const [, owedBeforeDebit] = await swap.backing();
  await (await swap.connect(operator).debitPremium(bob.address, mcgp(200), debitRef)).wait();
  assert((await swap.pendingSettle(bob.address)) === mcgp(200), "debit -> pendingSettle");
  assert((await swap.accountedMcgp()) === owedBeforeDebit, "C2: debit must NOT free backing");
  log("operator debitPremium 200 -> pendingSettle (backing NOT freed)");

  await (await swap.connect(operator).settleDebit(debitRef)).wait();
  assert((await swap.pendingSettle(bob.address)) === 0n, "settle clears pending");
  log("operator settleDebit (NGN paid) -> backing freed");

  const debitRef2 = refOf("IT:debit:" + "intent-bob-sell-2");
  await (await swap.connect(operator).debitPremium(bob.address, mcgp(50), debitRef2)).wait();
  await (await swap.connect(operator).reverseDebit(debitRef2)).wait();
  assert((await swap.pendingSettle(bob.address)) === 0n, "reverse clears pending");
  log("operator debit 50 then reverseDebit (NGN failed) -> premium restored");

  // Double-resolve guard.
  let dr = false;
  try { await swap.connect(operator).settleDebit(debitRef2); } catch { dr = true; }
  assert(dr, "a resolved debit cannot be settled again");
  log("two-phase single-resolution verified (no double-settle)");

  await assertBacking("final");
  const [held, owed] = await swap.backing();
  console.log(`${"=".repeat(60)}\nFINAL backing: held=${ethers.formatUnits(held, 18)} MCGP, owed=${ethers.formatUnits(owed, 18)} MCGP (held >= owed ✓)`);
  console.log("\n✅ FULL E2E PASSED — USDC path + IT operator path + legacy, invariants held throughout.\n");
}

main().catch((e) => { console.error("\n❌ E2E FAILED:", e); process.exitCode = 1; });
