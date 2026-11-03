# mcgp-otc-contracts

Solidity contracts for buying and selling the MCGP token against USDC on the [Sonic](https://www.soniclabs.com/) network, built with Hardhat and OpenZeppelin.

## Contracts
| Contract | Purpose |
|---|---|
| `McgpEntitlementSwap.sol` | MCGP/USDC swap that decides what each wallet may do from an **entitlement ledger** (provenance of the balance), not from the token balance alone. |
| `OtcMarketplace.sol` | Earlier, simpler marketplace: buy and sell against USDC with owner-managed price phases. |
| `mocks/ERC20Mock.sol` | Test and testnet stand-ins for MCGP and USDC. |

## Design: the entitlement ledger
The swap exists so that a naira (off-chain) credit can never become withdrawable on-chain value. Each wallet's balance is split by where it came from:

- **Legacy entitlement**: a pre-launch snapshot, redeem-only (`sellLegacy`), capped by what has already been redeemed.
- **Premium bought**: minted when a user buys with USDC (`buyPremium`). The only bucket that can be sold or withdrawn to a wallet.
- **Premium credited**: minted by an operator after an off-chain payment (`creditPremium`). Spend-only; its only exit is an operator-driven payout (`debitPremium` → `settleDebit`, reversible with `reverseDebit`).
- `spend` debits credited value first, then bought value, and gives the recipient the same type, so credited value cannot be laundered into withdrawable value.

Invariant: tokens held by the contract are always at least the sum of all bought, credited and pending-settlement balances (`backing()` returns held versus owed).

## Safety controls
- `Ownable`, `Pausable` and `ReentrancyGuard`; slippage limits on swaps (`minUsdc` / `maxUsdc`).
- Operators are separate from the owner and bounded by credit caps (per-transaction and rolling-window).
- Guardians can only `pause` or remove an operator, so a leaked operator key has limited reach.
- Not upgradeable. These contracts have not had a third-party audit.

## Develop
```bash
npm install
cp .env.example .env
npx hardhat compile
npx hardhat test

# dry-run the deploy config, then deploy
CHECK_ONLY=1 npx hardhat run scripts/deploy-entitlement-swap.js --network sonicTestnet
npx hardhat run scripts/deploy-entitlement-swap-testnet.js --network sonicTestnet
```
Networks: `hardhat` (1337), `sonic` (146), `sonicTestnet` (14601). Solidity 0.8.20, optimizer on.
