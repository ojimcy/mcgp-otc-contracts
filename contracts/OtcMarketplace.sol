// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title OtcMarketplace
 * @notice OTC Marketplace for buying and selling MCGP tokens with USDC
 * @dev Only admin can fund/withdraw and update price phases
 */
contract OtcMarketplace is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    IERC20 public immutable mcgpToken;
    IERC20 public immutable usdcToken;

    // Price phases configuration
    struct PricePhase {
        uint256 price; // Price in USDC (with 6 decimals) per MCGP (18 decimals)
        bool isActive;
        bool isBuyPhase; // true for buy phases, false for sell phases
        string name; // e.g., "1000X down", "2X up"
    }

    PricePhase[] public buyPhases;
    PricePhase[] public sellPhases;

    uint256 public activeBuyPhaseIndex;
    uint256 public activeSellPhaseIndex;

    // Max price to prevent overflow/DoS ($1,000,000 per MCGP)
    uint256 public constant MAX_PRICE = 1e12;

    // Events
    event Bought(address indexed buyer, uint256 mcgpAmount, uint256 usdcAmount, uint256 indexed phaseIndex);
    event Sold(address indexed seller, uint256 mcgpAmount, uint256 usdcAmount, uint256 indexed phaseIndex);
    event PhaseChanged(bool indexed isBuyPhase, uint256 indexed newPhaseIndex);
    event PriceUpdated(bool indexed isBuyPhase, uint256 indexed phaseIndex, uint256 newPrice);
    event Funded(address indexed token, uint256 amount);
    event Withdrawn(address indexed token, uint256 amount);

    /**
     * @param _mcgpToken Address of MCGP token
     * @param _usdcToken Address of USDC token
     */
    constructor(address _mcgpToken, address _usdcToken) Ownable(msg.sender) {
        require(_mcgpToken != address(0), "Invalid MCGP address");
        require(_usdcToken != address(0), "Invalid USDC address");
        
        mcgpToken = IERC20(_mcgpToken);
        usdcToken = IERC20(_usdcToken);

        // Initialize sell phases (presale price = $0.01)
        // Price is in USDC (6 decimals) per MCGP (18 decimals)
        // 1000X down = $0.00001 = 10 USDC (6 decimals) per 1 MCGP (18 decimals)
        sellPhases.push(PricePhase({
            price: 10, // $0.00001 per MCGP
            isActive: true,
            isBuyPhase: false,
            name: "1000X down"
        }));
        sellPhases.push(PricePhase({
            price: 100, // $0.0001 per MCGP
            isActive: false,
            isBuyPhase: false,
            name: "100X down"
        }));
        sellPhases.push(PricePhase({
            price: 1000, // $0.001 per MCGP
            isActive: false,
            isBuyPhase: false,
            name: "10X down"
        }));
        sellPhases.push(PricePhase({
            price: 10000, // $0.01 per MCGP (presale price)
            isActive: false,
            isBuyPhase: false,
            name: "1X up"
        }));
        sellPhases.push(PricePhase({
            price: 100000, // $0.1 per MCGP
            isActive: false,
            isBuyPhase: false,
            name: "10X up"
        }));
        sellPhases.push(PricePhase({
            price: 1000000, // $1 per MCGP
            isActive: false,
            isBuyPhase: false,
            name: "100X up"
        }));
        sellPhases.push(PricePhase({
            price: 10000000, // $10 per MCGP
            isActive: false,
            isBuyPhase: false,
            name: "1000X up"
        }));

        // Initialize buy phases
        // 2X up = $0.02 per MCGP
        buyPhases.push(PricePhase({
            price: 20000, // $0.02 per MCGP
            isActive: true,
            isBuyPhase: true,
            name: "2X up"
        }));
        buyPhases.push(PricePhase({
            price: 200000, // $0.2 per MCGP
            isActive: false,
            isBuyPhase: true,
            name: "20X up"
        }));
        buyPhases.push(PricePhase({
            price: 2000000, // $2 per MCGP
            isActive: false,
            isBuyPhase: true,
            name: "200X up"
        }));
        buyPhases.push(PricePhase({
            price: 20000000, // $20 per MCGP
            isActive: false,
            isBuyPhase: true,
            name: "2000X up"
        }));

        activeBuyPhaseIndex = 0;
        activeSellPhaseIndex = 0;
    }

    /**
     * @notice Calculate USDC amount needed for buying MCGP
     * @param mcgpAmount Amount of MCGP to buy (18 decimals)
     * @return USDC amount needed (6 decimals)
     */
    function calculateBuyPrice(uint256 mcgpAmount) public view returns (uint256) {
        PricePhase memory phase = buyPhases[activeBuyPhaseIndex];
        require(phase.isActive, "Buy phase not active");
        
        // price is USDC (6 decimals) per MCGP (18 decimals)
        // usdcAmount = (mcgpAmount * price) / 1e18
        return (mcgpAmount * phase.price) / 1e18;
    }

    /**
     * @notice Calculate USDC amount received for selling MCGP
     * @param mcgpAmount Amount of MCGP to sell (18 decimals)
     * @return USDC amount received (6 decimals)
     */
    function calculateSellPrice(uint256 mcgpAmount) public view returns (uint256) {
        PricePhase memory phase = sellPhases[activeSellPhaseIndex];
        require(phase.isActive, "Sell phase not active");
        
        // price is USDC (6 decimals) per MCGP (18 decimals)
        // usdcAmount = (mcgpAmount * price) / 1e18
        return (mcgpAmount * phase.price) / 1e18;
    }

    /**
     * @notice Buy MCGP with USDC
     * @param mcgpAmount Amount of MCGP to buy (18 decimals)
     * @param maxUsdcAmount Maximum USDC willing to pay (slippage protection)
     */
    function buy(uint256 mcgpAmount, uint256 maxUsdcAmount) external nonReentrant whenNotPaused {
        require(mcgpAmount > 0, "Amount must be greater than 0");

        uint256 usdcAmount = calculateBuyPrice(mcgpAmount);
        require(usdcAmount > 0, "USDC amount must be greater than 0");
        require(usdcAmount <= maxUsdcAmount, "Slippage exceeded");

        // Check contract has enough MCGP
        require(mcgpToken.balanceOf(address(this)) >= mcgpAmount, "Insufficient MCGP in contract");

        // Transfer USDC from buyer to contract
        usdcToken.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // Transfer MCGP from contract to buyer
        mcgpToken.safeTransfer(msg.sender, mcgpAmount);

        emit Bought(msg.sender, mcgpAmount, usdcAmount, activeBuyPhaseIndex);
    }

    /**
     * @notice Sell MCGP for USDC
     * @param mcgpAmount Amount of MCGP to sell (18 decimals)
     * @param minUsdcAmount Minimum USDC willing to receive (slippage protection)
     */
    function sell(uint256 mcgpAmount, uint256 minUsdcAmount) external nonReentrant whenNotPaused {
        require(mcgpAmount > 0, "Amount must be greater than 0");

        uint256 usdcAmount = calculateSellPrice(mcgpAmount);
        require(usdcAmount > 0, "USDC amount must be greater than 0");
        require(usdcAmount >= minUsdcAmount, "Slippage exceeded");

        // Check contract has enough USDC
        require(usdcToken.balanceOf(address(this)) >= usdcAmount, "Insufficient USDC in contract");

        // Transfer MCGP from seller to contract
        mcgpToken.safeTransferFrom(msg.sender, address(this), mcgpAmount);

        // Transfer USDC from contract to seller
        usdcToken.safeTransfer(msg.sender, usdcAmount);

        emit Sold(msg.sender, mcgpAmount, usdcAmount, activeSellPhaseIndex);
    }

    /**
     * @notice Set active buy phase (only owner)
     * @param phaseIndex Index of the phase to activate
     */
    function setActiveBuyPhase(uint256 phaseIndex) external onlyOwner {
        require(phaseIndex < buyPhases.length, "Invalid phase index");
        
        // Deactivate current phase
        buyPhases[activeBuyPhaseIndex].isActive = false;
        
        // Activate new phase
        activeBuyPhaseIndex = phaseIndex;
        buyPhases[phaseIndex].isActive = true;

        emit PhaseChanged(true, phaseIndex);
    }

    /**
     * @notice Set active sell phase (only owner)
     * @param phaseIndex Index of the phase to activate
     */
    function setActiveSellPhase(uint256 phaseIndex) external onlyOwner {
        require(phaseIndex < sellPhases.length, "Invalid phase index");
        
        // Deactivate current phase
        sellPhases[activeSellPhaseIndex].isActive = false;
        
        // Activate new phase
        activeSellPhaseIndex = phaseIndex;
        sellPhases[phaseIndex].isActive = true;

        emit PhaseChanged(false, phaseIndex);
    }

    /**
     * @notice Update price for a specific phase (only owner)
     * @param isBuyPhase True for buy phase, false for sell phase
     * @param phaseIndex Index of the phase to update
     * @param newPrice New price in USDC (6 decimals) per MCGP (18 decimals)
     */
    function updatePhasePrice(bool isBuyPhase, uint256 phaseIndex, uint256 newPrice) external onlyOwner {
        require(newPrice > 0, "Price must be greater than 0");
        require(newPrice <= MAX_PRICE, "Price exceeds maximum");
        
        if (isBuyPhase) {
            require(phaseIndex < buyPhases.length, "Invalid phase index");
            buyPhases[phaseIndex].price = newPrice;
        } else {
            require(phaseIndex < sellPhases.length, "Invalid phase index");
            sellPhases[phaseIndex].price = newPrice;
        }

        emit PriceUpdated(isBuyPhase, phaseIndex, newPrice);
    }

    /**
     * @notice Fund contract with tokens (only owner)
     * @param token Address of token to fund
     * @param amount Amount to fund
     */
    function fund(address token, uint256 amount) external onlyOwner {
        require(token == address(mcgpToken) || token == address(usdcToken), "Invalid token");
        require(amount > 0, "Amount must be greater than 0");

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit Funded(token, amount);
    }

    /**
     * @notice Withdraw tokens from contract (only owner)
     * @param token Address of token to withdraw
     * @param amount Amount to withdraw
     */
    function withdraw(address token, uint256 amount) external onlyOwner {
        require(token == address(mcgpToken) || token == address(usdcToken), "Invalid token");
        require(amount > 0, "Amount must be greater than 0");
        require(IERC20(token).balanceOf(address(this)) >= amount, "Insufficient balance");

        IERC20(token).safeTransfer(msg.sender, amount);

        emit Withdrawn(token, amount);
    }

    /**
     * @notice Pause trading (only owner)
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause trading (only owner)
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Get all buy phases
     */
    function getBuyPhases() external view returns (PricePhase[] memory) {
        return buyPhases;
    }

    /**
     * @notice Get all sell phases
     */
    function getSellPhases() external view returns (PricePhase[] memory) {
        return sellPhases;
    }

    /**
     * @notice Get contract balances
     */
    function getBalances() external view returns (uint256 mcgpBalance, uint256 usdcBalance) {
        mcgpBalance = mcgpToken.balanceOf(address(this));
        usdcBalance = usdcToken.balanceOf(address(this));
    }
}
