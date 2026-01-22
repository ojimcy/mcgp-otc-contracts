const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("OtcMarketplace", function () {
    let marketplace;
    let mcgpToken;
    let usdcToken;
    let owner;
    let user1;
    let user2;

    const INITIAL_SUPPLY = ethers.parseUnits("1000000", 18); // 1M tokens
    const USDC_INITIAL_SUPPLY = ethers.parseUnits("1000000", 6); // 1M USDC

    beforeEach(async function () {
        [owner, user1, user2] = await ethers.getSigners();

        // Deploy mock ERC20 tokens
        const ERC20Mock = await ethers.getContractFactory("contracts/mocks/ERC20Mock.sol:ERC20Mock");

        mcgpToken = await ERC20Mock.deploy("MCGP Token", "MCGP", 18);
        await mcgpToken.waitForDeployment();

        usdcToken = await ERC20Mock.deploy("USD Coin", "USDC", 6);
        await usdcToken.waitForDeployment();

        // Deploy marketplace
        const OtcMarketplace = await ethers.getContractFactory("OtcMarketplace");
        marketplace = await OtcMarketplace.deploy(await mcgpToken.getAddress(), await usdcToken.getAddress());
        await marketplace.waitForDeployment();

        // Mint tokens
        await mcgpToken.mint(owner.address, INITIAL_SUPPLY);
        await usdcToken.mint(owner.address, USDC_INITIAL_SUPPLY);
        await mcgpToken.mint(user1.address, ethers.parseUnits("10000", 18));
        await usdcToken.mint(user1.address, ethers.parseUnits("10000", 6));
    });

    describe("Deployment", function () {
        it("Should set the correct token addresses", async function () {
            expect(await marketplace.mcgpToken()).to.equal(await mcgpToken.getAddress());
            expect(await marketplace.usdcToken()).to.equal(await usdcToken.getAddress());
        });

        it("Should initialize buy and sell phases correctly", async function () {
            const buyPhases = await marketplace.getBuyPhases();
            const sellPhases = await marketplace.getSellPhases();

            expect(buyPhases.length).to.equal(4);
            expect(sellPhases.length).to.equal(7);

            // Check first buy phase is active
            expect(buyPhases[0].isActive).to.be.true;
            expect(buyPhases[0].name).to.equal("2X up");

            // Check first sell phase is active
            expect(sellPhases[0].isActive).to.be.true;
            expect(sellPhases[0].name).to.equal("1000X down");
        });
    });

    describe("Buy Functionality", function () {
        beforeEach(async function () {
            // Fund marketplace with MCGP
            await mcgpToken.approve(await marketplace.getAddress(), ethers.parseUnits("100000", 18));
            await marketplace.fund(await mcgpToken.getAddress(), ethers.parseUnits("100000", 18));
        });

        it("Should allow users to buy MCGP with USDC", async function () {
            const mcgpAmount = ethers.parseUnits("100", 18);
            const expectedUsdc = await marketplace.calculateBuyPrice(mcgpAmount);

            // Approve and buy
            await usdcToken.connect(user1).approve(await marketplace.getAddress(), expectedUsdc);

            await expect(marketplace.connect(user1).buy(mcgpAmount, expectedUsdc))
                .to.emit(marketplace, "Bought")
                .withArgs(user1.address, mcgpAmount, expectedUsdc, 0);

            // Check balances
            expect(await mcgpToken.balanceOf(user1.address)).to.equal(
                ethers.parseUnits("10100", 18)
            );
        });

        it("Should revert if user doesn't have enough USDC", async function () {
            const mcgpAmount = ethers.parseUnits("1000000", 18); // Very large amount
            const maxUsdc = ethers.parseUnits("1000000", 6);

            await expect(marketplace.connect(user1).buy(mcgpAmount, maxUsdc))
                .to.be.reverted;
        });

        it("Should revert if slippage exceeded on buy", async function () {
            const mcgpAmount = ethers.parseUnits("100", 18);
            const expectedUsdc = await marketplace.calculateBuyPrice(mcgpAmount);
            const tooLowMax = expectedUsdc - 1n;

            await usdcToken.connect(user1).approve(await marketplace.getAddress(), expectedUsdc);

            await expect(marketplace.connect(user1).buy(mcgpAmount, tooLowMax))
                .to.be.revertedWith("Slippage exceeded");
        });
    });

    describe("Sell Functionality", function () {
        beforeEach(async function () {
            // Fund marketplace with USDC
            await usdcToken.approve(await marketplace.getAddress(), ethers.parseUnits("100000", 6));
            await marketplace.fund(await usdcToken.getAddress(), ethers.parseUnits("100000", 6));
        });

        it("Should allow users to sell MCGP for USDC", async function () {
            const mcgpAmount = ethers.parseUnits("100", 18);
            const expectedUsdc = await marketplace.calculateSellPrice(mcgpAmount);

            // Approve and sell
            await mcgpToken.connect(user1).approve(await marketplace.getAddress(), mcgpAmount);

            await expect(marketplace.connect(user1).sell(mcgpAmount, expectedUsdc))
                .to.emit(marketplace, "Sold")
                .withArgs(user1.address, mcgpAmount, expectedUsdc, 0);

            // Check balances
            expect(await mcgpToken.balanceOf(user1.address)).to.equal(
                ethers.parseUnits("9900", 18)
            );
        });

        it("Should revert if slippage exceeded on sell", async function () {
            const mcgpAmount = ethers.parseUnits("100", 18);
            const expectedUsdc = await marketplace.calculateSellPrice(mcgpAmount);
            const tooHighMin = expectedUsdc + 1n;

            await mcgpToken.connect(user1).approve(await marketplace.getAddress(), mcgpAmount);

            await expect(marketplace.connect(user1).sell(mcgpAmount, tooHighMin))
                .to.be.revertedWith("Slippage exceeded");
        });
    });

    describe("Admin Functions", function () {
        it("Should allow owner to change buy phase", async function () {
            await expect(marketplace.setActiveBuyPhase(1))
                .to.emit(marketplace, "PhaseChanged")
                .withArgs(true, 1);

            const buyPhases = await marketplace.getBuyPhases();
            expect(buyPhases[0].isActive).to.be.false;
            expect(buyPhases[1].isActive).to.be.true;
        });

        it("Should allow owner to update phase price", async function () {
            const newPrice = 50000; // $0.05

            await expect(marketplace.updatePhasePrice(true, 0, newPrice))
                .to.emit(marketplace, "PriceUpdated")
                .withArgs(true, 0, newPrice);

            const buyPhases = await marketplace.getBuyPhases();
            expect(buyPhases[0].price).to.equal(newPrice);
        });

        it("Should revert if price exceeds maximum", async function () {
            const maxPrice = await marketplace.MAX_PRICE();
            const tooHighPrice = maxPrice + 1n;

            await expect(marketplace.updatePhasePrice(true, 0, tooHighPrice))
                .to.be.revertedWith("Price exceeds maximum");
        });

        it("Should allow owner to fund contract", async function () {
            const amount = ethers.parseUnits("1000", 18);
            await mcgpToken.approve(await marketplace.getAddress(), amount);

            await expect(marketplace.fund(await mcgpToken.getAddress(), amount))
                .to.emit(marketplace, "Funded")
                .withArgs(await mcgpToken.getAddress(), amount);
        });

        it("Should allow owner to withdraw from contract", async function () {
            // First fund
            const amount = ethers.parseUnits("1000", 18);
            await mcgpToken.approve(await marketplace.getAddress(), amount);
            await marketplace.fund(await mcgpToken.getAddress(), amount);

            // Then withdraw
            await expect(marketplace.withdraw(await mcgpToken.getAddress(), amount))
                .to.emit(marketplace, "Withdrawn")
                .withArgs(await mcgpToken.getAddress(), amount);
        });

        it("Should revert if non-owner tries to change phase", async function () {
            await expect(marketplace.connect(user1).setActiveBuyPhase(1))
                .to.be.revertedWithCustomError(marketplace, "OwnableUnauthorizedAccount");
        });
    });

    describe("Price Calculations", function () {
        it("Should calculate buy price correctly", async function () {
            // Active buy phase 0: 2X up = $0.02 per MCGP = 20000 (USDC with 6 decimals)
            const mcgpAmount = ethers.parseUnits("1", 18); // 1 MCGP
            const expectedUsdc = 20000n; // $0.02 in USDC (6 decimals)

            expect(await marketplace.calculateBuyPrice(mcgpAmount)).to.equal(expectedUsdc);
        });

        it("Should calculate sell price correctly", async function () {
            // Active sell phase 0: 1000X down = $0.00001 per MCGP = 10 (USDC with 6 decimals)
            const mcgpAmount = ethers.parseUnits("1", 18); // 1 MCGP
            const expectedUsdc = 10n; // $0.00001 in USDC (6 decimals)

            expect(await marketplace.calculateSellPrice(mcgpAmount)).to.equal(expectedUsdc);
        });
    });

    describe("Pause Functionality", function () {
        beforeEach(async function () {
            // Fund marketplace with both tokens
            await mcgpToken.approve(await marketplace.getAddress(), ethers.parseUnits("100000", 18));
            await marketplace.fund(await mcgpToken.getAddress(), ethers.parseUnits("100000", 18));
            await usdcToken.approve(await marketplace.getAddress(), ethers.parseUnits("100000", 6));
            await marketplace.fund(await usdcToken.getAddress(), ethers.parseUnits("100000", 6));
        });

        it("Should allow owner to pause and unpause", async function () {
            await expect(marketplace.pause())
                .to.emit(marketplace, "Paused")
                .withArgs(owner.address);

            expect(await marketplace.paused()).to.be.true;

            await expect(marketplace.unpause())
                .to.emit(marketplace, "Unpaused")
                .withArgs(owner.address);

            expect(await marketplace.paused()).to.be.false;
        });

        it("Should block buy when paused", async function () {
            const mcgpAmount = ethers.parseUnits("100", 18);
            const maxUsdc = ethers.parseUnits("10", 6);

            await usdcToken.connect(user1).approve(await marketplace.getAddress(), maxUsdc);

            // Pause the contract
            await marketplace.pause();

            await expect(marketplace.connect(user1).buy(mcgpAmount, maxUsdc))
                .to.be.revertedWithCustomError(marketplace, "EnforcedPause");
        });

        it("Should block sell when paused", async function () {
            const mcgpAmount = ethers.parseUnits("100", 18);

            await mcgpToken.connect(user1).approve(await marketplace.getAddress(), mcgpAmount);

            // Pause the contract
            await marketplace.pause();

            await expect(marketplace.connect(user1).sell(mcgpAmount, 0))
                .to.be.revertedWithCustomError(marketplace, "EnforcedPause");
        });

        it("Should allow trading after unpause", async function () {
            const mcgpAmount = ethers.parseUnits("100", 18);
            const expectedUsdc = await marketplace.calculateBuyPrice(mcgpAmount);

            await usdcToken.connect(user1).approve(await marketplace.getAddress(), expectedUsdc);

            // Pause then unpause
            await marketplace.pause();
            await marketplace.unpause();

            // Should work now
            await expect(marketplace.connect(user1).buy(mcgpAmount, expectedUsdc))
                .to.emit(marketplace, "Bought");
        });

        it("Should revert if non-owner tries to pause", async function () {
            await expect(marketplace.connect(user1).pause())
                .to.be.revertedWithCustomError(marketplace, "OwnableUnauthorizedAccount");
        });
    });
});
