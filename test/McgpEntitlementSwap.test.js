const { expect } = require("chai");
const { ethers } = require("hardhat");

// PriceKind enum
const PREMIUM_BUY = 0;
const PREMIUM_SELL = 1;
const LEGACY_SELL = 2;

const mcgp = (n) => ethers.parseUnits(String(n), 18);
const usdc = (n) => ethers.parseUnits(String(n), 6);
const refOf = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

describe("McgpEntitlementSwap (Swap Contract B)", function () {
  let swap, mcgpToken, usdcToken;
  let owner, alice, bob, merchant;

  // Prices (USDC 6dp per 1 MCGP): premium buy $0.02, premium sell $0.018, legacy $0.01
  const PREMIUM_BUY_PRICE = 20000;
  const PREMIUM_SELL_PRICE = 18000;
  const LEGACY_SELL_PRICE = 10000;

  beforeEach(async function () {
    [owner, alice, bob, merchant] = await ethers.getSigners();

    const ERC20Mock = await ethers.getContractFactory("contracts/mocks/ERC20Mock.sol:ERC20Mock");
    mcgpToken = await ERC20Mock.deploy("MCGP Token", "MCGP", 18);
    await mcgpToken.waitForDeployment();
    usdcToken = await ERC20Mock.deploy("USD Coin", "USDC", 6);
    await usdcToken.waitForDeployment();

    const Swap = await ethers.getContractFactory("McgpEntitlementSwap");
    swap = await Swap.deploy(owner.address, await mcgpToken.getAddress(), await usdcToken.getAddress());
    await swap.waitForDeployment();

    // Configure phases (one phase each, active index 0).
    await swap.addPhase(PREMIUM_BUY, PREMIUM_BUY_PRICE, "premium buy");
    await swap.addPhase(PREMIUM_SELL, PREMIUM_SELL_PRICE, "premium sell");
    await swap.addPhase(LEGACY_SELL, LEGACY_SELL_PRICE, "legacy redeem");

    // Seed balances.
    await mcgpToken.mint(owner.address, mcgp(10_000_000));
    await usdcToken.mint(owner.address, usdc(10_000_000));
    await usdcToken.mint(alice.address, usdc(1_000_000));
    await usdcToken.mint(bob.address, usdc(1_000_000));
    await mcgpToken.mint(alice.address, mcgp(100_000)); // alice holds legacy MCGP in wallet
  });

  async function fundMcgp(amount) {
    await mcgpToken.approve(await swap.getAddress(), amount);
    await swap.fund(await mcgpToken.getAddress(), amount);
  }
  async function fundUsdc(amount) {
    await usdcToken.approve(await swap.getAddress(), amount);
    await swap.fund(await usdcToken.getAddress(), amount);
  }

  // Invariant: accountedMcgp == Σ premiumBalance, and held MCGP >= accountedMcgp.
  async function assertBacking(users) {
    let sum = 0n;
    for (const u of users) sum += await swap.premiumBalance(u.address);
    const accounted = await swap.accountedMcgp();
    expect(accounted).to.equal(sum);
    const [held, owed] = await swap.backing();
    expect(owed).to.equal(accounted);
    expect(held).to.be.gte(owed);
  }

  describe("Deployment", function () {
    it("sets tokens and owner", async function () {
      expect(await swap.mcgpToken()).to.equal(await mcgpToken.getAddress());
      expect(await swap.usdcToken()).to.equal(await usdcToken.getAddress());
      expect(await swap.owner()).to.equal(owner.address);
    });
    it("quotes per the active phase", async function () {
      expect(await swap.quote(PREMIUM_BUY, mcgp(100))).to.equal(usdc(2)); // 100 * 0.02
      expect(await swap.quote(LEGACY_SELL, mcgp(100))).to.equal(usdc(1)); // 100 * 0.01
    });
  });

  describe("Premium buy / backing", function () {
    it("credits premium balance, raises accountedMcgp, requires backing", async function () {
      await fundMcgp(mcgp(1000));
      const amount = mcgp(500);
      const cost = await swap.quote(PREMIUM_BUY, amount); // $10
      await usdcToken.connect(alice).approve(await swap.getAddress(), cost);
      await expect(swap.connect(alice).buyPremium(amount, cost))
        .to.emit(swap, "PremiumBought").withArgs(alice.address, amount, cost);
      expect(await swap.premiumBalance(alice.address)).to.equal(amount);
      expect(await swap.accountedMcgp()).to.equal(amount);
      await assertBacking([alice, bob, merchant]);
    });

    it("reverts when underbacked (MCGP not funded)", async function () {
      const amount = mcgp(500);
      const cost = await swap.quote(PREMIUM_BUY, amount);
      await usdcToken.connect(alice).approve(await swap.getAddress(), cost);
      await expect(swap.connect(alice).buyPremium(amount, cost))
        .to.be.revertedWith("Underbacked: fund MCGP first");
    });

    it("enforces slippage on buy", async function () {
      await fundMcgp(mcgp(1000));
      const amount = mcgp(500);
      const cost = await swap.quote(PREMIUM_BUY, amount);
      await usdcToken.connect(alice).approve(await swap.getAddress(), cost);
      await expect(swap.connect(alice).buyPremium(amount, cost - 1n))
        .to.be.revertedWith("Slippage exceeded");
    });
  });

  describe("Spend (premium, user-signed, idempotent)", function () {
    beforeEach(async function () {
      await fundMcgp(mcgp(1000));
      const cost = await swap.quote(PREMIUM_BUY, mcgp(500));
      await usdcToken.connect(alice).approve(await swap.getAddress(), cost);
      await swap.connect(alice).buyPremium(mcgp(500), cost);
    });

    it("moves premium between wallets and keeps accountedMcgp constant", async function () {
      const before = await swap.accountedMcgp();
      await expect(swap.connect(alice).spend(merchant.address, mcgp(120), refOf("order-1")))
        .to.emit(swap, "PremiumSpent").withArgs(alice.address, merchant.address, mcgp(120), refOf("order-1"));
      expect(await swap.premiumBalance(alice.address)).to.equal(mcgp(380));
      expect(await swap.premiumBalance(merchant.address)).to.equal(mcgp(120));
      expect(await swap.accountedMcgp()).to.equal(before);
      await assertBacking([alice, bob, merchant]);
    });

    it("rejects a reused ref (idempotency)", async function () {
      await swap.connect(alice).spend(merchant.address, mcgp(10), refOf("order-2"));
      await expect(swap.connect(alice).spend(merchant.address, mcgp(10), refOf("order-2")))
        .to.be.revertedWith("Ref already used");
    });

    it("rejects spend beyond balance / to self / zero ref", async function () {
      await expect(swap.connect(alice).spend(merchant.address, mcgp(10_000), refOf("x")))
        .to.be.revertedWith("Insufficient premium balance");
      await expect(swap.connect(alice).spend(alice.address, mcgp(1), refOf("y")))
        .to.be.revertedWith("Cannot spend to self");
      await expect(swap.connect(alice).spend(merchant.address, mcgp(1), ethers.ZeroHash))
        .to.be.revertedWith("Invalid ref");
    });
  });

  describe("Premium sell / withdraw", function () {
    beforeEach(async function () {
      await fundMcgp(mcgp(1000));
      await fundUsdc(usdc(100_000));
      const cost = await swap.quote(PREMIUM_BUY, mcgp(500));
      await usdcToken.connect(alice).approve(await swap.getAddress(), cost);
      await swap.connect(alice).buyPremium(mcgp(500), cost);
    });

    it("sells premium for USDC at the premium sell price and lowers accountedMcgp", async function () {
      const proceeds = await swap.quote(PREMIUM_SELL, mcgp(200)); // 200 * 0.018 = $3.6
      const balBefore = await usdcToken.balanceOf(alice.address);
      await expect(swap.connect(alice).sellPremium(mcgp(200), proceeds))
        .to.emit(swap, "PremiumSold");
      expect(await swap.premiumBalance(alice.address)).to.equal(mcgp(300));
      expect(await swap.accountedMcgp()).to.equal(mcgp(300));
      expect(await usdcToken.balanceOf(alice.address)).to.equal(balBefore + proceeds);
      await assertBacking([alice, bob, merchant]);
    });

    it("withdraws premium to wallet as real MCGP (even when paused)", async function () {
      await swap.pause();
      const walBefore = await mcgpToken.balanceOf(alice.address);
      await expect(swap.connect(alice).withdrawPremiumToWallet(mcgp(100)))
        .to.emit(swap, "PremiumWithdrawn").withArgs(alice.address, mcgp(100));
      expect(await swap.premiumBalance(alice.address)).to.equal(mcgp(400));
      expect(await swap.accountedMcgp()).to.equal(mcgp(400));
      expect(await mcgpToken.balanceOf(alice.address)).to.equal(walBefore + mcgp(100));
      await assertBacking([alice, bob, merchant]);
    });
  });

  describe("Legacy (redeem-only, capped at snapshot)", function () {
    beforeEach(async function () {
      await fundUsdc(usdc(100_000));
      await swap.seedLegacy([alice.address], [mcgp(1000)]);
    });

    it("redeems legacy MCGP for USDC at the legacy price, up to entitlement", async function () {
      const proceeds = await swap.quote(LEGACY_SELL, mcgp(400)); // $4
      await mcgpToken.connect(alice).approve(await swap.getAddress(), mcgp(400));
      const usdcBefore = await usdcToken.balanceOf(alice.address);
      await expect(swap.connect(alice).sellLegacy(mcgp(400), proceeds))
        .to.emit(swap, "LegacyRedeemed").withArgs(alice.address, mcgp(400), proceeds);
      expect(await swap.legacyRedeemed(alice.address)).to.equal(mcgp(400));
      expect(await swap.legacyRemaining(alice.address)).to.equal(mcgp(600));
      expect(await usdcToken.balanceOf(alice.address)).to.equal(usdcBefore + proceeds);
      // Legacy redemption must NOT touch premium backing.
      expect(await swap.accountedMcgp()).to.equal(0);
    });

    it("reverts when redeeming beyond entitlement", async function () {
      await mcgpToken.connect(alice).approve(await swap.getAddress(), mcgp(2000));
      await expect(swap.connect(alice).sellLegacy(mcgp(1001), 0))
        .to.be.revertedWith("Exceeds legacy entitlement");
    });

    it("a non-seeded user has zero entitlement and cannot redeem", async function () {
      await mcgpToken.mint(bob.address, mcgp(100));
      await mcgpToken.connect(bob).approve(await swap.getAddress(), mcgp(100));
      await expect(swap.connect(bob).sellLegacy(mcgp(1), 0))
        .to.be.revertedWith("Exceeds legacy entitlement");
    });
  });

  describe("Admin withdraw (MCGP excess only, USDC free)", function () {
    it("blocks withdrawing user-owed premium MCGP; allows true excess", async function () {
      await fundMcgp(mcgp(1000));
      const cost = await swap.quote(PREMIUM_BUY, mcgp(500));
      await usdcToken.connect(alice).approve(await swap.getAddress(), cost);
      await swap.connect(alice).buyPremium(mcgp(500), cost);
      // held = 1000, owed = 500 -> excess = 500.
      await expect(swap.withdraw(await mcgpToken.getAddress(), owner.address, mcgp(501)))
        .to.be.revertedWith("Exceeds withdrawable MCGP excess");
      await expect(swap.withdraw(await mcgpToken.getAddress(), owner.address, mcgp(500)))
        .to.emit(swap, "Withdrawn");
      await assertBacking([alice, bob, merchant]);
    });
  });

  describe("Pause + access control", function () {
    it("pause blocks buy/spend/sell/legacy but never withdrawPremiumToWallet", async function () {
      await fundMcgp(mcgp(1000));
      const cost = await swap.quote(PREMIUM_BUY, mcgp(500));
      await usdcToken.connect(alice).approve(await swap.getAddress(), cost);
      await swap.connect(alice).buyPremium(mcgp(500), cost);
      await swap.pause();
      await expect(swap.connect(alice).buyPremium(mcgp(1), 0)).to.be.revertedWithCustomError(swap, "EnforcedPause");
      await expect(swap.connect(alice).spend(merchant.address, mcgp(1), refOf("p"))).to.be.revertedWithCustomError(swap, "EnforcedPause");
      await expect(swap.connect(alice).sellPremium(mcgp(1), 0)).to.be.revertedWithCustomError(swap, "EnforcedPause");
      await expect(swap.connect(alice).withdrawPremiumToWallet(mcgp(1))).to.emit(swap, "PremiumWithdrawn");
    });

    it("only owner can seed/fund/withdraw/phase/pause", async function () {
      await expect(swap.connect(alice).seedLegacy([bob.address], [mcgp(1)])).to.be.revertedWithCustomError(swap, "OwnableUnauthorizedAccount");
      await expect(swap.connect(alice).addPhase(PREMIUM_BUY, 1, "x")).to.be.revertedWithCustomError(swap, "OwnableUnauthorizedAccount");
      await expect(swap.connect(alice).pause()).to.be.revertedWithCustomError(swap, "OwnableUnauthorizedAccount");
      await expect(swap.connect(alice).withdraw(await usdcToken.getAddress(), alice.address, 1)).to.be.revertedWithCustomError(swap, "OwnableUnauthorizedAccount");
    });
  });
});
