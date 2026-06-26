// LIVE E2E against a deployed McgpEntitlementSwap v2 (Sonic testnet, mock tokens).
// Runs REAL transactions: user-signed buy/spend/sell/withdraw/legacy + the
// operator IT path (credit/debit/settle/reverse) + a live C1 revert check.
//
//   SWAP=0x.. MCGP=0x.. USDC=0x.. \
//   npx hardhat run scripts/smoke-it-e2e-live.js --network sonicTestnet
//
// Requires PRIVATE_KEY (the deployer = owner) funded with testnet S. The deployer
// plays owner/operator/treasury/buyer; one ephemeral wallet is funded for the
// credited-user (C1) checks. Refs are per-run unique so it can be re-run.
const { ethers } = require("hardhat");
const assert = require("assert");

const SWAP = process.env.SWAP || "0xF6C5F52f4Dd2F2037a9148F75Cc80bCDC9E3001c";
const MCGP = process.env.MCGP || "0x722aD20775d0cF2ACA667A2d82fA5E62b6Aaa87f";
const USDC = process.env.USDC || "0xc49988D51CC2cA40F9563fffE67BF95b10A0037B";
const PREMIUM_BUY = 0;
const mc = (n) => ethers.parseUnits(String(n), 18);
const RUN = Date.now().toString();
const ref = (k) => ethers.keccak256(ethers.toUtf8Bytes(`live:${RUN}:${k}`));
let step = 0;
const log = (m) => console.log(`  [${String(++step).padStart(2, "0")}] ${m}`);
const expectRevert = async (p, label) => {
  let r = false;
  try { await (await p).wait(); } catch { r = true; }
  assert(r, `${label}: expected revert`);
};

async function main() {
  const [D] = await ethers.getSigners();
  const swap = await ethers.getContractAt("McgpEntitlementSwap", SWAP);
  const mcgp = await ethers.getContractAt("contracts/mocks/ERC20Mock.sol:ERC20Mock", MCGP);
  const usdc = await ethers.getContractAt("contracts/mocks/ERC20Mock.sol:ERC20Mock", USDC);
  console.log(`\nLIVE E2E  swap=${SWAP}\n  deployer/owner/operator = ${D.address}\n${"=".repeat(64)}`);

  const backingOK = async (l) => { const [h, o] = await swap.backing(); assert(h >= o, `${l}: backing h=${h} o=${o}`); };

  // Ensure deployer is an operator (idempotent).
  if (!(await swap.operators(D.address))) { await (await swap.addOperator(D.address)).wait(); log("addOperator(deployer)"); }
  else log("deployer already operator");

  // Mint mock funds to deployer; ensure USDC float + MCGP backing.
  await (await usdc.mint(D.address, ethers.parseUnits("100000", 6))).wait();
  await (await mcgp.mint(D.address, mc(50000))).wait();
  if ((await usdc.balanceOf(SWAP)) < ethers.parseUnits("10000", 6)) {
    await (await usdc.approve(SWAP, ethers.parseUnits("50000", 6))).wait();
    await (await swap.fund(USDC, ethers.parseUnits("50000", 6))).wait();
    log("funded USDC float");
  }
  if ((await swap.backing())[0] < mc(10000)) {
    await (await mcgp.approve(SWAP, mc(50000))).wait();
    await (await swap.fund(MCGP, mc(50000))).wait();
    log("funded MCGP backing");
  }
  await backingOK("post-fund");

  // Ephemeral credited-user, funded for gas.
  const user = ethers.Wallet.createRandom().connect(ethers.provider);
  await (await D.sendTransaction({ to: user.address, value: ethers.parseEther("0.3") })).wait();
  log(`funded ephemeral user ${user.address} with 0.3 S gas`);

  // ── user-signed USDC path (deployer as buyer) ─────────────────────────────
  const b0 = await swap.premiumBought(D.address);
  let cost = await swap.quote(PREMIUM_BUY, mc(100));
  await (await usdc.approve(SWAP, cost)).wait();
  await (await swap.buyPremium(mc(100), cost)).wait();
  assert((await swap.premiumBought(D.address)) === b0 + mc(100), "buy +100 bought");
  log(`buyPremium 100 MCGP for $${Number(cost) / 1e6}`);

  await (await swap.spend(user.address, mc(30), ref("spend1"))).wait();
  assert((await swap.premiumBought(user.address)) >= mc(30), "spend->user bought");
  log("spend 30 (bought) -> user");

  await (await swap.sellPremium(mc(20), 0)).wait(); log("sellPremium 20 -> USDC");
  await (await swap.withdrawPremiumToWallet(mc(10)).then(t => t.wait())); log("withdrawPremiumToWallet 10");

  await (await swap.seedLegacy([D.address], [mc(200)])).wait();
  await (await mcgp.approve(SWAP, mc(200))).wait();
  await (await swap.sellLegacy(mc(100), 0)).wait();
  assert((await swap.legacyRemaining(D.address)) === mc(100), "legacy remaining 100");
  log("seedLegacy 200 + sellLegacy 100 -> USDC");
  await backingOK("after USDC+legacy");

  // ── operator IT path ──────────────────────────────────────────────────────
  await (await swap.creditPremium(user.address, mc(500), ref("credit"))).wait();
  assert((await swap.premiumCredited(user.address)) === mc(500), "credit +500");
  log("operator creditPremium 500 -> user.premiumCredited");

  // C1 live: user cannot withdraw beyond its bought bucket (credited is spend-only).
  const uBought = await swap.premiumBought(user.address);
  await expectRevert(swap.connect(user).withdrawPremiumToWallet(uBought + mc(1)), "C1 withdraw");
  log("C1 verified live: user cannot withdraw into credited bucket");

  // user spends credited -> deployer; recipient receives credited (bucket preserved).
  const dCredBefore = await swap.premiumCredited(D.address);
  await (await swap.connect(user).spend(D.address, mc(50), ref("spend2"))).wait();
  assert((await swap.premiumCredited(D.address)) === dCredBefore + mc(50), "credited bucket preserved on spend");
  log("user spend 50 (credited) -> deployer (stays credited)");

  // two-phase debit: settle.
  const accBefore = await swap.accountedMcgp();
  await (await swap.debitPremium(user.address, mc(100), ref("debit1"))).wait();
  assert((await swap.pendingSettle(user.address)) === mc(100), "pendingSettle 100");
  assert((await swap.accountedMcgp()) === accBefore, "debit frees no backing");
  log("debitPremium 100 -> pendingSettle (backing NOT freed)");
  await (await swap.settleDebit(ref("debit1")).then(t => t.wait()));
  assert((await swap.pendingSettle(user.address)) === 0n, "settle clears pending");
  log("settleDebit -> backing freed");

  // two-phase debit: reverse.
  await (await swap.debitPremium(user.address, mc(25), ref("debit2"))).wait();
  await (await swap.reverseDebit(ref("debit2")).then(t => t.wait()));
  assert((await swap.pendingSettle(user.address)) === 0n, "reverse clears pending");
  log("debit 25 + reverseDebit -> premium restored");
  await expectRevert(swap.settleDebit(ref("debit2")), "double-resolve");
  log("single-resolution verified (no settle after reverse)");

  await backingOK("final");
  const [h, o] = await swap.backing();
  console.log(`${"=".repeat(64)}\nFINAL backing: held=${ethers.formatUnits(h, 18)} owed=${ethers.formatUnits(o, 18)} (held>=owed ✓)`);
  console.log(`\n✅ LIVE E2E PASSED on Sonic testnet.  https://testnet.sonicscan.org/address/${SWAP}\n`);
}

main().catch((e) => { console.error("\n❌ LIVE E2E FAILED:", e); process.exitCode = 1; });
