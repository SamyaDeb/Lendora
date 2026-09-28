// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @title USDG Earn: the delta-neutral vault (docs/prd/08-delta-neutral-vault.md DN-R1, DN-R5, DN-R6, DN-R9, DN-R12).
/// @notice ERC-4626 over USDG priced at `NavOracle.nav()`. Deposits are **entries**: a compliance attestation (the
/// router's signer, RT-R2), a fresh NAV, the feed session open, not paused and inside the total cap. Withdrawals are
/// **exits**: instant up to the vault's idle USDG while the NAV is fresh and the session open; otherwise, or above
/// that, an ERC-7540-style request that anyone can make at any time (no attestation, paused or not, stale NAV or not)
/// and that settles FIFO at the NAV of its settlement, within 72h or at the next US open, whichever is later.
/// Settled requests are claimable at any time.
interface IDeltaNeutralVault {
    /// @notice The router's compliance attestation (same signer and EIP-712 domain, RT-R2).
    struct Attestation {
        uint256 expiry;
        bytes signature;
    }

    enum RequestStatus {
        None,
        Queued,
        Claimable,
        Claimed
    }

    struct Request {
        address owner;
        address receiver;
        uint128 shares;
        uint128 assets; // set at settlement
        uint64 requestedAt;
        uint64 settleBy; // DN-R1 deadline: max(requestedAt + 72h, the next US open after that)
        RequestStatus status;
    }

    event RedeemRequested(
        uint256 indexed id, address indexed owner, address indexed receiver, uint256 shares, uint64 settleBy
    );
    event RedeemSettled(uint256 indexed id, uint256 shares, uint256 assets);
    event Claimed(uint256 indexed id, address indexed receiver, uint256 assets);
    event FeeAccrued(uint256 feeShares, uint256 sharePriceWad, uint256 highWaterMarkWad);
    event TotalCapSet(uint256 cap);
    event DepositsPausedSet(bool paused);
    event FeeRecipientSet(address recipient);
    event BufferSet(uint256 bps);
    event GuardianSet(address guardian);
    event StrategySet(address strategy);
    event NavOracleSet(address oracle);
    event SentToStrategy(uint256 amount);

    error AttestationRequired();
    error BadAttestation();
    error NavStale();
    error MarketClosed();
    error DepositsPaused();
    error CapExceeded(uint256 totalAfter, uint256 cap);
    error ExceedsInstant(uint256 assets, uint256 maxAssets);
    error NotClaimable(uint256 id);
    error NotStrategy();
    error NotGuardian();
    error ZeroAmount();
    error ZeroAddress();
    error BufferBreached(uint256 idleAfter, uint256 minIdle);
    error AlreadySet();
    error BadParam();
    error QueueOverdue(uint256 id);

    /// @notice DN-R9 performance fee (10% of gains above the high-water mark), WAD.
    function PERFORMANCE_FEE() external view returns (uint256);
    /// @notice DN-R1: minimum queue time before the next-open rule, seconds (72h).
    function QUEUE_MIN() external view returns (uint256);

    /// @notice Entry: deposit `assets` USDG for `receiver` with the caller's attestation.
    function deposit(uint256 assets, address receiver, Attestation calldata att) external returns (uint256 shares);
    /// @notice Exit: escrow `shares` of `owner` (caller or approved) for FIFO settlement; always accepted.
    function requestRedeem(uint256 shares, address receiver, address owner) external returns (uint256 id);
    /// @notice Anyone: settle up to `maxCount` queued requests in order, at the current fresh NAV, while the session
    /// is open, as long as idle USDG covers each; stops at the first it can't pay.
    function settle(uint256 maxCount) external returns (uint256 settled);
    /// @notice Anyone: pay a settled request to its receiver (never gated).
    function claim(uint256 id) external returns (uint256 assets);
    /// @notice Strategy only: send `amount` idle USDG to the strategy, keeping the cash buffer; refused while the queue
    /// head is past its deadline (cash goes to exits first).
    function sendToStrategy(uint256 amount) external;
    /// @notice Anyone: mint the performance fee on gains above the high-water mark (needs a fresh NAV).
    function accrueFee() external;

    /// @notice USDG in the vault not owed to settled requests.
    function idleAssets() external view returns (uint256);
    /// @notice USDG owed to settled, unclaimed requests.
    function reserved() external view returns (uint256);
    /// @notice USDG withdrawable instantly now (0 while the NAV is stale or the session closed).
    function instantCapacity() external view returns (uint256);
    /// @notice Request `id`.
    function request(uint256 id) external view returns (Request memory);
    /// @notice Next request to settle, and one past the last.
    function queueBounds() external view returns (uint256 head, uint256 tail);
    /// @notice Shares escrowed in unsettled requests.
    function escrowedShares() external view returns (uint256);
    /// @notice USDG per share, WAD (at the current NAV).
    function sharePrice() external view returns (uint256);
    /// @notice DN-R9 high-water mark of the share price, WAD.
    function highWaterMark() external view returns (uint256);
    /// @notice DN-R6 total cap on NAV, USDG raw (0 at launch).
    function totalCap() external view returns (uint256);
    /// @notice Whether the feed session is open (DN-R12: mint/burn only then).
    function marketOpen() external view returns (bool);
    /// @notice The DN-R1 settlement deadline for a request made at `t`.
    function settleByFor(uint256 t) external view returns (uint64);
}
