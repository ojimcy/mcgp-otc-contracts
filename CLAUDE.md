# smart-contracts (repo: `ojimcy/mcgp-otc-contracts`)

MCGP⇄USDC swap contracts on **Sonic**. This is *not* the TSA Connect escrow repo — the
P2P/product escrow, FeeManager, and reward distributor live in `../tsa-dev/smart-contracts/`
(different repo, Solidity 0.8.24, Sonic + BSC). Confirm with `git remote -v` before editing a
`.sol` file.

Workspace context: `../CLAUDE.md`.

## Stack

Solidity 0.8.20 (optimizer on, 200 runs) · Hardhat 2 + hardhat-toolbox 3 ·
OpenZeppelin Contracts 5 · dotenv. Networks: `hardhat` (1337), `sonic` (146),
`sonicTestnet` (14601). Etherscan verification is wired for both Sonic chains.

## Commands

```bash
npx hardhat compile
npx hardhat test                                  # all
npx hardhat test test/McgpEntitlementSwap.test.js # single file

# deploy (CHECK_ONLY=1 for a dry run that just logs the resolved config)
npx hardhat run scripts/deploy-entitlement-swap.js --network sonic
npx hardhat run scripts/deploy-entitlement-swap-testnet.js --network sonicTestnet
npx hardhat run scripts/deploy.js --network sonic            # OtcMarketplace

# live E2E against a deployed swap (real txs, needs funded PRIVATE_KEY)
SWAP=0x.. MCGP=0x.. USDC=0x.. npx hardhat run scripts/smoke-it-e2e-live.js --network sonicTestnet
```

`npm test` in `package.json` is a stub that exits 1 — use `npx hardhat test`.

## Contracts

- **`McgpEntitlementSwap.sol`** ("Swap Contract B") — the live one. MCGP⇄USDC swap that
  differentiates holders via a per-wallet **entitlement ledger** instead of the token itself.
  Non-upgradeable; `Ownable` + `Pausable` + `ReentrancyGuard`, owner should be a multisig with a
  guardian set that can only `pause` / `removeOperator`.
- **`OtcMarketplace.sol`** — the earlier, simpler buy/sell-with-phases marketplace. Owner funds,
  withdraws, and flips price phases. Kept for the existing OTC console.
- **`contracts/mocks/ERC20Mock.sol`** — test/testnet stand-ins for MCGP and USDC.

## Entitlement-ledger invariants (do not break)

The whole design exists so an NGN ("Instant Transfer") credit can never become withdrawable
value. Provenance, not balance, decides what a user may do:

- `legacyEntitlement` — pre-launch snapshot, **redeem-only** via `sellLegacy`, capped by
  `legacyRedeemed`.
- `premiumBought` — minted by user-signed `buyPremium` (USDC in). The **only** bucket
  `withdrawPremiumToWallet` and `sellPremium` may draw from.
- `premiumCredited` — minted by an operator's `creditPremium` after an off-chain NGN payment.
  **Spend-only**: its sole exit is the operator-driven NGN payout path
  (`debitPremium` → `settleDebit`, reversible via `reverseDebit`). This is what bounds a
  compromised operator key.
- `spend` debits credited-first, then bought, and credits the recipient the **same bucket type** —
  so credited value can never launder into self-exitable value.
- `accountedMcgp == Σ(premiumBought + premiumCredited + pendingSettle)` and
  `mcgpToken.balanceOf(this) >= accountedMcgp` at all times. `backing()` exposes held vs owed.
- `usedRef` gives on-chain idempotency for operator refs; keep refs domain-separated per caller.

Prices are USDC (6dp) per 1 MCGP (18dp): `usdc = mcgp * price / 1e18`, capped by
`MAX_PRICE = 1e12`. Three independent phase lists keyed by `PriceKind`
(`PremiumBuy` / `PremiumSell` / `LegacySell`) each with their own `activePhase`.

## Deployment bookkeeping

There is **no `deployments/` file in this repo** — deployed addresses are not tracked here
(unlike `tsa-dev/smart-contracts`, which writes `deployments/<network>.json`). The consumers hold
them instead:

- Backend: `MCGP_SWAP_B_ADDRESS` env var (`tsa-api-go/internal/config/config.go`).
- Admin console: `tsa-admin/src/abi/mcgp-entitlement-swap.ts` + the MCGP swap/OTC pages.
- `scripts/smoke-it-e2e-live.js` carries the Sonic-testnet swap and mock-token addresses as
  defaults — the closest thing to a recorded testnet deployment.

Deploy defaults (Sonic mainnet MCGP/USDC addresses, phase prices) are baked into
`scripts/deploy-entitlement-swap.js` and overridable by env (`OWNER_ADDRESS`,
`MCGP_TOKEN_ADDRESS`, `USDC_TOKEN_ADDRESS`, `PREMIUM_BUY_PRICE`, `PREMIUM_SELL_PRICE`,
`LEGACY_SELL_PRICE`). Read that header before deploying.

Contracts here are **not upgradeable** — a fix means a fresh deploy plus re-seeding
(`seedLegacy`) and re-pointing every consumer. Prefer `pause` + a migration plan over a hasty
redeploy.

## Env

`.env` (never commit): `PRIVATE_KEY` (deployer/owner), `SONIC_RPC_URL`,
`SONIC_TESTNET_RPC_URL`, `ETHERSCAN_API_KEY`.
