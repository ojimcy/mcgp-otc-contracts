// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title McgpEntitlementSwap  ("Swap Contract B")
 * @notice MCGP⇄USDC swap that differentiates holders by a per-wallet ENTITLEMENT
 *         LEDGER rather than by the (fungible, immutable) token. Premium is split
 *         by PROVENANCE so the NGN "Instant Transfer" (IT) path can credit
 *         spendable MCGP without ever creating a treasury-drain.
 *
 *   LEGACY  — pre-launch holders; `legacyEntitlement` seeded from a snapshot.
 *             REDEEM-ONLY via `sellLegacy` (USDC at the legacy price, capped).
 *
 *   PREMIUM (two provenance buckets, both spendable via `spend`):
 *     • premiumBought   — minted by user-signed `buyPremium` (USDC in). SELF-
 *                         EXITABLE: `withdrawPremiumToWallet` / `sellPremium`.
 *     • premiumCredited — minted by operator `creditPremium` after an off-chain
 *                         NGN payment (IT). SPEND-ONLY: it has NO on-chain cash-
 *                         out; its only exit is an operator-driven NGN payout
 *                         (`debitPremium` → `settleDebit`). This is what bounds a
 *                         compromised operator key — it can mis-attribute or
 *                         grief, but can never turn credited MCGP into wallet
 *                         MCGP/USDC.
 *
 * @dev Invariants:
 *   - accountedMcgp == Σ(premiumBought + premiumCredited + pendingSettle), and
 *     mcgpToken.balanceOf(this) >= accountedMcgp at all times.
 *   - premiumBought is the ONLY bucket `withdrawPremiumToWallet`/`sellPremium`
 *     can draw from; operators only ever touch premiumCredited/pendingSettle.
 *   - `spend` debits credited-first then bought and credits the recipient the
 *     SAME bucket type, so credited value can never become self-exitable.
 *   - Owner SHOULD be a multisig; a low-threshold guardian set can pause +
 *     removeOperator for fast incident response. Non-upgradeable.
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
        string name;
    }

    mapping(uint8 => PricePhase[]) private _phases;
    mapping(uint8 => uint256) public activePhase;
    uint256 public constant MAX_PRICE = 1e12; // $1,000,000 per MCGP (6dp)

    // ──────────────────────── Entitlement ledger ───────────────────────
    mapping(address => uint256) public legacyEntitlement;
    mapping(address => uint256) public legacyRedeemed;

    mapping(address => uint256) public premiumBought;    // USDC-bought; self-exitable
    mapping(address => uint256) public premiumCredited;  // operator/NGN; spend-only
    mapping(address => uint256) public pendingSettle;    // debited, awaiting NGN payout

    uint256 public accountedMcgp;            // == Σ(bought + credited + pendingSettle)
    mapping(bytes32 => bool) public usedRef; // on-chain idempotency (domain-separated by caller)

    // Two-phase NGN-sell debit, keyed by the debit ref so settle/reverse bind to
    // the exact debit (no double-resolve, no cross-trade cannibalization).
    enum DebitState { None, Pending, Resolved }
    struct Debit { address user; uint256 amount; DebitState state; }
    mapping(bytes32 => Debit) public debits; // debitRef => Debit

    // ──────────────────────── Operator / guardian ──────────────────────
    mapping(address => bool) public operators; // PM automation signer(s) for the IT/NGN path
    mapping(address => bool) public guardians; // emergency: pause + removeOperator only

    // Operator-credit safety caps (0 = disabled). Bound a compromised operator key.
    uint256 public minCredit;        // reject dust credits
    uint256 public maxCreditPerTx;   // per-call ceiling
    uint256 public creditWindow;     // rolling window length (seconds)
    uint256 public creditWindowCap;  // max credited per window
    uint256 public windowStart;
    uint256 public creditedInWindow;

    // ───────────────────────────── Events ──────────────────────────────
    event LegacySeeded(address indexed user, uint256 entitlement);
    event LegacyRedeemed(address indexed user, uint256 mcgpAmount, uint256 usdcAmount);
    event PremiumBought(address indexed buyer, uint256 mcgpAmount, uint256 usdcAmount);
    event PremiumSold(address indexed seller, uint256 mcgpAmount, uint256 usdcAmount);
    event PremiumSpent(address indexed from, address indexed to, uint256 mcgpAmount, bytes32 indexed ref);
    event PremiumWithdrawn(address indexed user, uint256 mcgpAmount);
    // IT / operator path
    event PremiumCredited(address indexed user, uint256 mcgpAmount, bytes32 indexed ref);
    event PremiumDebitPending(address indexed user, uint256 mcgpAmount, bytes32 indexed ref);
    event PremiumDebitSettled(address indexed user, uint256 mcgpAmount, bytes32 indexed ref);
    event PremiumDebitReversed(address indexed user, uint256 mcgpAmount, bytes32 indexed ref);
    event OperatorAdded(address indexed operator);
    event OperatorRemoved(address indexed operator);
    event GuardianAdded(address indexed guardian);
    event GuardianRemoved(address indexed guardian);
    event CreditCapsUpdated(uint256 minCredit, uint256 maxCreditPerTx, uint256 creditWindow, uint256 creditWindowCap);
    // admin
    event PhaseAdded(uint8 indexed kind, uint256 indexed index, uint256 price, string name);
    event PhaseActivated(uint8 indexed kind, uint256 indexed index);
    event PhasePriceUpdated(uint8 indexed kind, uint256 indexed index, uint256 newPrice);
    event Funded(address indexed token, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    modifier onlyOperator() {
        require(operators[msg.sender], "Not operator");
        _;
    }
    modifier onlyOwnerOrGuardian() {
        require(msg.sender == owner() || guardians[msg.sender], "Not owner/guardian");
        _;
    }

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
    function sellLegacy(uint256 mcgpAmount, uint256 minUsdc) external nonReentrant whenNotPaused {
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
        // Legacy MCGP in (becomes inventory), USDC out. Untouched: accountedMcgp.
        mcgpToken.safeTransferFrom(msg.sender, address(this), mcgpAmount);
        usdcToken.safeTransfer(msg.sender, usdcAmount);

        emit LegacyRedeemed(msg.sender, mcgpAmount, usdcAmount);
    }

    function legacyRemaining(address user) external view returns (uint256) {
        uint256 cap = legacyEntitlement[user];
        uint256 used = legacyRedeemed[user];
        return cap > used ? cap - used : 0;
    }

    // ═══════════════════════ Premium — user-signed ═════════════════════
    /// @notice Buy self-exitable premium (premiumBought) with USDC.
    function buyPremium(uint256 mcgpAmount, uint256 maxUsdc) external nonReentrant whenNotPaused {
        require(mcgpAmount > 0, "Amount must be > 0");

        uint256 usdcAmount = quote(PriceKind.PremiumBuy, mcgpAmount);
        require(usdcAmount > 0, "USDC amount must be > 0");
        require(usdcAmount <= maxUsdc, "Slippage exceeded");

        usdcToken.safeTransferFrom(msg.sender, address(this), usdcAmount);
        premiumBought[msg.sender] += mcgpAmount;
        accountedMcgp += mcgpAmount;
        require(mcgpToken.balanceOf(address(this)) >= accountedMcgp, "Underbacked: fund MCGP first");

        emit PremiumBought(msg.sender, mcgpAmount, usdcAmount);
    }

    /// @notice Total spendable premium (both buckets).
    function premiumBalanceOf(address user) public view returns (uint256) {
        return premiumBought[user] + premiumCredited[user];
    }

    /**
     * @notice Spend premium to another wallet (marketplace/peer). Debits
     *         credited-first then bought, and credits the recipient the SAME
     *         bucket type — so operator-credited (spend-only) value can never
     *         become self-exitable downstream.
     */
    function spend(address to, uint256 amount, bytes32 ref) external nonReentrant whenNotPaused {
        require(to != address(0), "Invalid recipient");
        require(to != msg.sender, "Cannot spend to self");
        require(amount > 0, "Amount must be > 0");
        require(ref != bytes32(0), "Invalid ref");
        require(!usedRef[ref], "Ref already used");
        require(premiumBalanceOf(msg.sender) >= amount, "Insufficient premium balance");

        usedRef[ref] = true;
        uint256 fromCredited = premiumCredited[msg.sender] >= amount ? amount : premiumCredited[msg.sender];
        uint256 fromBought = amount - fromCredited;
        if (fromCredited > 0) {
            premiumCredited[msg.sender] -= fromCredited;
            premiumCredited[to] += fromCredited;
        }
        if (fromBought > 0) {
            premiumBought[msg.sender] -= fromBought;
            premiumBought[to] += fromBought;
        }
        // accountedMcgp unchanged: still owed, to a different holder.

        emit PremiumSpent(msg.sender, to, amount, ref);
    }

    /// @notice Sell SELF-EXITABLE premium (premiumBought only) back for USDC.
    function sellPremium(uint256 mcgpAmount, uint256 minUsdc) external nonReentrant whenNotPaused {
        require(mcgpAmount > 0, "Amount must be > 0");
        require(premiumBought[msg.sender] >= mcgpAmount, "Insufficient bought premium");

        uint256 usdcAmount = quote(PriceKind.PremiumSell, mcgpAmount);
        require(usdcAmount > 0, "USDC amount must be > 0");
        require(usdcAmount >= minUsdc, "Slippage exceeded");
        require(usdcToken.balanceOf(address(this)) >= usdcAmount, "Insufficient USDC");

        premiumBought[msg.sender] -= mcgpAmount;
        accountedMcgp -= mcgpAmount;
        usdcToken.safeTransfer(msg.sender, usdcAmount);

        emit PremiumSold(msg.sender, mcgpAmount, usdcAmount);
    }

    /// @notice Trustless exit (premiumBought only). NOT pausable.
    function withdrawPremiumToWallet(uint256 mcgpAmount) external nonReentrant {
        require(mcgpAmount > 0, "Amount must be > 0");
        require(premiumBought[msg.sender] >= mcgpAmount, "Insufficient bought premium");

        premiumBought[msg.sender] -= mcgpAmount;
        accountedMcgp -= mcgpAmount;
        mcgpToken.safeTransfer(msg.sender, mcgpAmount);

        emit PremiumWithdrawn(msg.sender, mcgpAmount);
    }

    // ═══════════════════ Premium — operator (IT / NGN) ═════════════════
    /**
     * @notice Credit SPEND-ONLY premium after an off-chain NGN payment settles.
     *         Cannot mint unbacked premium; bounded by per-tx + rolling-window
     *         caps. `ref` must be domain-separated and single-use.
     */
    function creditPremium(address user, uint256 amount, bytes32 ref)
        external
        onlyOperator
        nonReentrant
        whenNotPaused
    {
        require(user != address(0), "Invalid user");
        require(amount > 0, "Amount must be > 0");
        require(amount >= minCredit, "Below min credit");
        require(maxCreditPerTx == 0 || amount <= maxCreditPerTx, "Over per-tx cap");
        require(ref != bytes32(0), "Invalid ref");
        require(!usedRef[ref], "Ref already used");

        _rollWindow();
        require(creditWindowCap == 0 || creditedInWindow + amount <= creditWindowCap, "Over window cap");
        creditedInWindow += amount;

        usedRef[ref] = true;
        premiumCredited[user] += amount;
        accountedMcgp += amount;
        require(mcgpToken.balanceOf(address(this)) >= accountedMcgp, "Underbacked: fund MCGP first");

        emit PremiumCredited(user, amount, ref);
    }

    /// @notice Begin an NGN sell: move credited premium into pendingSettle, keyed
    ///         by `debitRef`. Backing is NOT freed yet (accountedMcgp unchanged) so
    ///         no withdrawable excess appears while the payout is in flight.
    function debitPremium(address user, uint256 amount, bytes32 debitRef)
        external
        onlyOperator
        nonReentrant
        whenNotPaused
    {
        require(amount > 0, "Amount must be > 0");
        require(debitRef != bytes32(0), "Invalid ref");
        require(debits[debitRef].state == DebitState.None, "Debit exists");
        require(premiumCredited[user] >= amount, "Insufficient credited premium");

        premiumCredited[user] -= amount;
        pendingSettle[user] += amount;
        debits[debitRef] = Debit({ user: user, amount: amount, state: DebitState.Pending });

        emit PremiumDebitPending(user, amount, debitRef);
    }

    /// @notice Finalize an NGN sell after a confirmed Nomba payout: free the
    ///         backing (the MCGP becomes withdrawable TSA excess). `whenNotPaused`
    ///         so a compromised operator cannot free backing during incident
    ///         response (pause stops settles; reverses stay open below).
    function settleDebit(bytes32 debitRef) external onlyOperator nonReentrant whenNotPaused {
        Debit storage d = debits[debitRef];
        require(d.state == DebitState.Pending, "Not pending");
        d.state = DebitState.Resolved;
        pendingSettle[d.user] -= d.amount;
        accountedMcgp -= d.amount;
        emit PremiumDebitSettled(d.user, d.amount, debitRef);
    }

    /// @notice Reverse an NGN sell whose payout failed: restore the user's
    ///         credited premium. Backing unchanged. Deliberately callable while
    ///         paused — it only makes a user whole, never frees backing.
    function reverseDebit(bytes32 debitRef) external onlyOperator nonReentrant {
        Debit storage d = debits[debitRef];
        require(d.state == DebitState.Pending, "Not pending");
        d.state = DebitState.Resolved;
        pendingSettle[d.user] -= d.amount;
        premiumCredited[d.user] += d.amount;
        emit PremiumDebitReversed(d.user, d.amount, debitRef);
    }

    function _rollWindow() internal {
        if (creditWindow == 0) return;
        if (block.timestamp >= windowStart + creditWindow) {
            windowStart = block.timestamp;
            creditedInWindow = 0;
        }
    }

    // ═════════════════════════════ Views ═══════════════════════════════
    /// @notice (MCGP held by contract, MCGP owed = accountedMcgp).
    function backing() external view returns (uint256 held, uint256 owed) {
        held = mcgpToken.balanceOf(address(this));
        owed = accountedMcgp;
    }

    function getPhases(PriceKind kind) external view returns (PricePhase[] memory) {
        return _phases[uint8(kind)];
    }

    // ════════════════════════════ Admin ════════════════════════════════
    function seedLegacy(address[] calldata users, uint256[] calldata amounts) external onlyOwner {
        require(users.length == amounts.length, "Length mismatch");
        for (uint256 i = 0; i < users.length; i++) {
            legacyEntitlement[users[i]] = amounts[i];
            emit LegacySeeded(users[i], amounts[i]);
        }
    }

    function addOperator(address op) external onlyOwner {
        require(op != address(0), "Invalid operator");
        operators[op] = true;
        emit OperatorAdded(op);
    }

    /// @notice Removable by owner OR a guardian (fast incident response).
    function removeOperator(address op) external onlyOwnerOrGuardian {
        operators[op] = false;
        emit OperatorRemoved(op);
    }

    function addGuardian(address g) external onlyOwner {
        require(g != address(0), "Invalid guardian");
        guardians[g] = true;
        emit GuardianAdded(g);
    }

    function removeGuardian(address g) external onlyOwner {
        guardians[g] = false;
        emit GuardianRemoved(g);
    }

    function setCreditCaps(uint256 _minCredit, uint256 _maxCreditPerTx, uint256 _creditWindow, uint256 _creditWindowCap)
        external
        onlyOwner
    {
        minCredit = _minCredit;
        maxCreditPerTx = _maxCreditPerTx;
        creditWindow = _creditWindow;
        creditWindowCap = _creditWindowCap;
        windowStart = block.timestamp;
        creditedInWindow = 0;
        emit CreditCapsUpdated(_minCredit, _maxCreditPerTx, _creditWindow, _creditWindowCap);
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

    function fund(address token, uint256 amount) external onlyOwner {
        require(token == address(mcgpToken) || token == address(usdcToken), "Invalid token");
        require(amount > 0, "Amount must be > 0");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(token, amount);
    }

    /// @notice Withdraw inventory. MCGP only up to TRUE EXCESS (held - accountedMcgp),
    ///         so user-owed premium (incl. pendingSettle) can never be removed.
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

    /// @notice Pausable by owner or guardian (incident response).
    function pause() external onlyOwnerOrGuardian { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
