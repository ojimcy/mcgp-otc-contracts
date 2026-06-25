// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title McgpEntitlementSwap  ("Swap Contract B")
 * @notice Second MCGP⇄USDC swap that differentiates holders by a per-wallet
 *         ENTITLEMENT LEDGER rather than by the token (MCGP is fungible and its
 *         contract is immutable). Two buckets, treated differently:
 *
 *           • LEGACY  — pre-launch holders. `legacyEntitlement[user]` is seeded
 *             from a snapshot. They may REDEEM (sell) up to that entitlement to
 *             USDC at the legacy price. Legacy is REDEEM-ONLY: it is never
 *             spendable in the marketplace (so merchants are never paid in
 *             low-value legacy balance).
 *
 *           • PREMIUM — post-launch buyers. `buyPremium()` mints spendable
 *             `premiumBalance[user]` at the premium price (paid in USDC, backed
 *             1:1 by real MCGP held in this contract). Premium balance is
 *             SPENDABLE (marketplace + peer pay via `spend`) and redeemable via
 *             `sellPremium`, and can be withdrawn to the wallet (un-pausable
 *             exit) — at which point it becomes ordinary, non-spendable wallet
 *             MCGP.
 *
 * @dev Design notes / invariants:
 *   - Every value-moving call is USER-SIGNED (msg.sender). There is no operator
 *     key that can move another user's balance.
 *   - Premium is fully collateralized: `accountedMcgp == Σ premiumBalance` and
 *     `mcgpToken.balanceOf(this) >= accountedMcgp` is enforced on every credit.
 *   - Premium balance is created ONLY by `buyPremium` (paying the premium
 *     price). Legacy is capped at the snapshot entitlement. These two rules keep
 *     free/airdropped/post-snapshot MCGP from ever gaining premium or legacy
 *     value.
 *   - Owner SHOULD be a multisig. Non-upgradeable by design (no upgrade-drain
 *     vector; a new version is a fresh deploy + re-seed).
 */
contract McgpEntitlementSwap is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    IERC20 public immutable mcgpToken;
    IERC20 public immutable usdcToken;

    // ───────────────────────────── Pricing ─────────────────────────────
    // Price is USDC (6 decimals) per 1 MCGP (18 decimals): usdc = mcgp * price / 1e18.
    enum PriceKind { PremiumBuy, PremiumSell, LegacySell }

    struct PricePhase {
        uint256 price; // USDC (6dp) per MCGP (18dp)
        string name;   // e.g. "2X up"
    }

    mapping(uint8 => PricePhase[]) private _phases;   // PriceKind => phases
    mapping(uint8 => uint256) public activePhase;     // PriceKind => active index

    // Max price to prevent overflow/DoS ($1,000,000 per MCGP, 6dp).
    uint256 public constant MAX_PRICE = 1e12;

    // ──────────────────────── Entitlement ledger ───────────────────────
    mapping(address => uint256) public legacyEntitlement; // snapshot cap (MCGP, 18dp)
    mapping(address => uint256) public legacyRedeemed;    // cumulative legacy redeemed
    mapping(address => uint256) public premiumBalance;    // spendable premium (MCGP, 18dp)

    uint256 public accountedMcgp;                         // == Σ premiumBalance; backing target
    mapping(bytes32 => bool) public usedRef;              // on-chain idempotency for spend

    // ───────────────────────────── Events ──────────────────────────────
    event LegacySeeded(address indexed user, uint256 entitlement);
    event LegacyRedeemed(address indexed user, uint256 mcgpAmount, uint256 usdcAmount);
    event PremiumBought(address indexed buyer, uint256 mcgpAmount, uint256 usdcAmount);
    event PremiumSold(address indexed seller, uint256 mcgpAmount, uint256 usdcAmount);
    event PremiumSpent(address indexed from, address indexed to, uint256 mcgpAmount, bytes32 indexed ref);
    event PremiumWithdrawn(address indexed user, uint256 mcgpAmount);
    event PhaseAdded(uint8 indexed kind, uint256 indexed index, uint256 price, string name);
    event PhaseActivated(uint8 indexed kind, uint256 indexed index);
    event PhasePriceUpdated(uint8 indexed kind, uint256 indexed index, uint256 newPrice);
    event Funded(address indexed token, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    /**
     * @param _owner     Contract owner (SHOULD be a multisig).
     * @param _mcgpToken MCGP token address (immutable).
     * @param _usdcToken USDC token address (immutable).
     */
    constructor(address _owner, address _mcgpToken, address _usdcToken) Ownable(_owner) {
        require(_mcgpToken != address(0), "Invalid MCGP address");
        require(_usdcToken != address(0), "Invalid USDC address");
        mcgpToken = IERC20(_mcgpToken);
        usdcToken = IERC20(_usdcToken);
    }

    // ════════════════════════════ Pricing math ═════════════════════════
    function _activePrice(PriceKind kind) internal view returns (uint256) {
        PricePhase[] storage ph = _phases[uint8(kind)];
        require(ph.length > 0, "No phase configured");
        uint256 price = ph[activePhase[uint8(kind)]].price;
        require(price > 0, "Price not set");
        return price;
    }

    /// @notice USDC (6dp) for `mcgpAmount` (18dp) at the active phase of `kind`.
    function quote(PriceKind kind, uint256 mcgpAmount) public view returns (uint256) {
        return (mcgpAmount * _activePrice(kind)) / 1e18;
    }

    // ═══════════════════════════ Legacy (redeem-only) ══════════════════
    /**
     * @notice Redeem pre-launch MCGP for USDC at the legacy price, capped at the
     *         snapshot entitlement. User sends real MCGP in; receives USDC.
     *         Legacy is NOT spendable — this is the only legacy exit.
     */
    function sellLegacy(uint256 mcgpAmount, uint256 minUsdc)
        external
        nonReentrant
        whenNotPaused
    {
        require(mcgpAmount > 0, "Amount must be > 0");
        require(
            legacyRedeemed[msg.sender] + mcgpAmount <= legacyEntitlement[msg.sender],
            "Exceeds legacy entitlement"
        );

        uint256 usdcAmount = quote(PriceKind.LegacySell, mcgpAmount);
        require(usdcAmount > 0, "USDC amount must be > 0");
        require(usdcAmount >= minUsdc, "Slippage exceeded");
        require(usdcToken.balanceOf(address(this)) >= usdcAmount, "Insufficient USDC");

        legacyRedeemed[msg.sender] += mcgpAmount;

        // Pull legacy MCGP in (becomes contract inventory / withdrawable excess),
        // pay USDC out. Does NOT touch accountedMcgp (premium backing).
        mcgpToken.safeTransferFrom(msg.sender, address(this), mcgpAmount);
        usdcToken.safeTransfer(msg.sender, usdcAmount);

        emit LegacyRedeemed(msg.sender, mcgpAmount, usdcAmount);
    }

    /// @notice Remaining legacy a user may still redeem.
    function legacyRemaining(address user) external view returns (uint256) {
        uint256 cap = legacyEntitlement[user];
        uint256 used = legacyRedeemed[user];
        return cap > used ? cap - used : 0;
    }

    // ═══════════════════════════ Premium (spendable) ═══════════════════
    /**
     * @notice Buy spendable premium MCGP with USDC at the premium price. Credits
     *         the internal `premiumBalance` (NOT the wallet) and requires the
     *         contract to already hold enough MCGP to back it 1:1.
     * @param mcgpAmount Premium MCGP to buy (18dp).
     * @param maxUsdc    Max USDC willing to pay (slippage protection).
     */
    function buyPremium(uint256 mcgpAmount, uint256 maxUsdc)
        external
        nonReentrant
        whenNotPaused
    {
        require(mcgpAmount > 0, "Amount must be > 0");

        uint256 usdcAmount = quote(PriceKind.PremiumBuy, mcgpAmount);
        require(usdcAmount > 0, "USDC amount must be > 0");
        require(usdcAmount <= maxUsdc, "Slippage exceeded");

        // Pull USDC, credit premium balance, raise the backing target.
        usdcToken.safeTransferFrom(msg.sender, address(this), usdcAmount);
        premiumBalance[msg.sender] += mcgpAmount;
        accountedMcgp += mcgpAmount;

        // Backing invariant: real MCGP held must cover all premium owed.
        require(mcgpToken.balanceOf(address(this)) >= accountedMcgp, "Underbacked: fund MCGP first");

        emit PremiumBought(msg.sender, mcgpAmount, usdcAmount);
    }

    /**
     * @notice Spend premium balance to another wallet (marketplace order or peer
     *         pay). User-signed; moves premium between balances 1:1 (no price).
     *         USD valuation of an order is computed off-chain by the backend.
     * @param to     Recipient (merchant or peer).
     * @param amount Premium MCGP to move (18dp).
     * @param ref    Idempotency key (e.g. keccak256(orderId)); single-use.
     */
    function spend(address to, uint256 amount, bytes32 ref)
        external
        nonReentrant
        whenNotPaused
    {
        require(to != address(0), "Invalid recipient");
        require(to != msg.sender, "Cannot spend to self");
        require(amount > 0, "Amount must be > 0");
        require(ref != bytes32(0), "Invalid ref");
        require(!usedRef[ref], "Ref already used");
        require(premiumBalance[msg.sender] >= amount, "Insufficient premium balance");

        usedRef[ref] = true;
        premiumBalance[msg.sender] -= amount;
        premiumBalance[to] += amount;
        // accountedMcgp unchanged: still owed, just to a different holder.

        emit PremiumSpent(msg.sender, to, amount, ref);
    }

    /**
     * @notice Sell premium balance back for USDC at the premium sell price.
     * @param mcgpAmount Premium MCGP to sell (18dp).
     * @param minUsdc    Min USDC willing to receive (slippage protection).
     */
    function sellPremium(uint256 mcgpAmount, uint256 minUsdc)
        external
        nonReentrant
        whenNotPaused
    {
        require(mcgpAmount > 0, "Amount must be > 0");
        require(premiumBalance[msg.sender] >= mcgpAmount, "Insufficient premium balance");

        uint256 usdcAmount = quote(PriceKind.PremiumSell, mcgpAmount);
        require(usdcAmount > 0, "USDC amount must be > 0");
        require(usdcAmount >= minUsdc, "Slippage exceeded");
        require(usdcToken.balanceOf(address(this)) >= usdcAmount, "Insufficient USDC");

        premiumBalance[msg.sender] -= mcgpAmount;
        accountedMcgp -= mcgpAmount;
        // MCGP backing stays as inventory (becomes withdrawable excess); pay USDC.
        usdcToken.safeTransfer(msg.sender, usdcAmount);

        emit PremiumSold(msg.sender, mcgpAmount, usdcAmount);
    }

    /**
     * @notice Trustless exit: withdraw premium balance to the wallet as real
     *         MCGP. Deliberately NOT pausable so funds can never be trapped.
     *         Withdrawn MCGP becomes ordinary, non-spendable wallet MCGP.
     */
    function withdrawPremiumToWallet(uint256 mcgpAmount) external nonReentrant {
        require(mcgpAmount > 0, "Amount must be > 0");
        require(premiumBalance[msg.sender] >= mcgpAmount, "Insufficient premium balance");

        premiumBalance[msg.sender] -= mcgpAmount;
        accountedMcgp -= mcgpAmount;
        mcgpToken.safeTransfer(msg.sender, mcgpAmount);

        emit PremiumWithdrawn(msg.sender, mcgpAmount);
    }

    // ═════════════════════════════ Views ═══════════════════════════════
    /// @notice (MCGP held by contract, MCGP owed to premium holders).
    function backing() external view returns (uint256 held, uint256 owed) {
        held = mcgpToken.balanceOf(address(this));
        owed = accountedMcgp;
    }

    function getPhases(PriceKind kind) external view returns (PricePhase[] memory) {
        return _phases[uint8(kind)];
    }

    // ════════════════════════════ Admin ════════════════════════════════
    /**
     * @notice Seed legacy entitlements from the pre-launch holder snapshot.
     *         Idempotent per call (overwrites the entitlement). Owner-only.
     */
    function seedLegacy(address[] calldata users, uint256[] calldata amounts)
        external
        onlyOwner
    {
        require(users.length == amounts.length, "Length mismatch");
        for (uint256 i = 0; i < users.length; i++) {
            legacyEntitlement[users[i]] = amounts[i];
            emit LegacySeeded(users[i], amounts[i]);
        }
    }

    function addPhase(PriceKind kind, uint256 price, string calldata name) external onlyOwner {
        require(price > 0 && price <= MAX_PRICE, "Invalid price");
        _phases[uint8(kind)].push(PricePhase({ price: price, name: name }));
        emit PhaseAdded(uint8(kind), _phases[uint8(kind)].length - 1, price, name);
    }

    function setActivePhase(PriceKind kind, uint256 index) external onlyOwner {
        require(index < _phases[uint8(kind)].length, "Invalid phase index");
        activePhase[uint8(kind)] = index;
        emit PhaseActivated(uint8(kind), index);
    }

    function updatePhasePrice(PriceKind kind, uint256 index, uint256 newPrice) external onlyOwner {
        require(newPrice > 0 && newPrice <= MAX_PRICE, "Invalid price");
        require(index < _phases[uint8(kind)].length, "Invalid phase index");
        _phases[uint8(kind)][index].price = newPrice;
        emit PhasePriceUpdated(uint8(kind), index, newPrice);
    }

    /// @notice Fund the contract with MCGP (premium inventory) or USDC (payout float).
    function fund(address token, uint256 amount) external onlyOwner {
        require(token == address(mcgpToken) || token == address(usdcToken), "Invalid token");
        require(amount > 0, "Amount must be > 0");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(token, amount);
    }

    /**
     * @notice Withdraw inventory. For MCGP, only the TRUE EXCESS over premium
     *         backing may be removed — user-owed premium MCGP can never be
     *         withdrawn. USDC (TSA's float) may be withdrawn freely.
     */
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        require(amount > 0, "Amount must be > 0");
        if (token == address(mcgpToken)) {
            uint256 held = mcgpToken.balanceOf(address(this));
            uint256 excess = held > accountedMcgp ? held - accountedMcgp : 0;
            require(amount <= excess, "Exceeds withdrawable MCGP excess");
            mcgpToken.safeTransfer(to, amount);
        } else if (token == address(usdcToken)) {
            require(usdcToken.balanceOf(address(this)) >= amount, "Insufficient USDC");
            usdcToken.safeTransfer(to, amount);
        } else {
            revert("Invalid token");
        }
        emit Withdrawn(token, to, amount);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
