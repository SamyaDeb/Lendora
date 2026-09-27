/**
 * Morpho Blue events (`morpho-blue/src/libraries/EventsLib.sol`, v1.0.0). They are not part of the `IMorpho` ABI, and
 * forge's `EventsLib` artifact name collides with MetaMorpho's, so they are written out here and checked against the
 * Solidity source by `test/morphoEvents.test.ts` (SI-R1: the indexer subscribes to exactly these signatures).
 */
export const morphoEventsAbi = [
  {
    type: "event",
    name: "CreateMarket",
    inputs: [
      {name: "id", type: "bytes32", indexed: true},
      {
        name: "marketParams",
        type: "tuple",
        indexed: false,
        components: [
          {name: "loanToken", type: "address"},
          {name: "collateralToken", type: "address"},
          {name: "oracle", type: "address"},
          {name: "irm", type: "address"},
          {name: "lltv", type: "uint256"},
        ],
      },
    ],
  },
  {
    type: "event",
    name: "Supply",
    inputs: [
      {name: "id", type: "bytes32", indexed: true},
      {name: "caller", type: "address", indexed: true},
      {name: "onBehalf", type: "address", indexed: true},
      {name: "assets", type: "uint256", indexed: false},
      {name: "shares", type: "uint256", indexed: false},
    ],
  },
  {
    type: "event",
    name: "Withdraw",
    inputs: [
      {name: "id", type: "bytes32", indexed: true},
      {name: "caller", type: "address", indexed: false},
      {name: "onBehalf", type: "address", indexed: true},
      {name: "receiver", type: "address", indexed: true},
      {name: "assets", type: "uint256", indexed: false},
      {name: "shares", type: "uint256", indexed: false},
    ],
  },
  {
    type: "event",
    name: "Borrow",
    inputs: [
      {name: "id", type: "bytes32", indexed: true},
      {name: "caller", type: "address", indexed: false},
      {name: "onBehalf", type: "address", indexed: true},
      {name: "receiver", type: "address", indexed: true},
      {name: "assets", type: "uint256", indexed: false},
      {name: "shares", type: "uint256", indexed: false},
    ],
  },
  {
    type: "event",
    name: "Repay",
    inputs: [
      {name: "id", type: "bytes32", indexed: true},
      {name: "caller", type: "address", indexed: true},
      {name: "onBehalf", type: "address", indexed: true},
      {name: "assets", type: "uint256", indexed: false},
      {name: "shares", type: "uint256", indexed: false},
    ],
  },
  {
    type: "event",
    name: "SupplyCollateral",
    inputs: [
      {name: "id", type: "bytes32", indexed: true},
      {name: "caller", type: "address", indexed: true},
      {name: "onBehalf", type: "address", indexed: true},
      {name: "assets", type: "uint256", indexed: false},
    ],
  },
  {
    type: "event",
    name: "WithdrawCollateral",
    inputs: [
      {name: "id", type: "bytes32", indexed: true},
      {name: "caller", type: "address", indexed: false},
      {name: "onBehalf", type: "address", indexed: true},
      {name: "receiver", type: "address", indexed: true},
      {name: "assets", type: "uint256", indexed: false},
    ],
  },
  {
    type: "event",
    name: "Liquidate",
    inputs: [
      {name: "id", type: "bytes32", indexed: true},
      {name: "caller", type: "address", indexed: true},
      {name: "borrower", type: "address", indexed: true},
      {name: "repaidAssets", type: "uint256", indexed: false},
      {name: "repaidShares", type: "uint256", indexed: false},
      {name: "seizedAssets", type: "uint256", indexed: false},
      {name: "badDebtAssets", type: "uint256", indexed: false},
      {name: "badDebtShares", type: "uint256", indexed: false},
    ],
  },
  {
    type: "event",
    name: "AccrueInterest",
    inputs: [
      {name: "id", type: "bytes32", indexed: true},
      {name: "prevBorrowRate", type: "uint256", indexed: false},
      {name: "interest", type: "uint256", indexed: false},
      {name: "feeShares", type: "uint256", indexed: false},
    ],
  },
  {
    type: "event",
    name: "SetAuthorization",
    inputs: [
      {name: "caller", type: "address", indexed: true},
      {name: "authorizer", type: "address", indexed: true},
      {name: "authorized", type: "address", indexed: true},
      {name: "newIsAuthorized", type: "bool", indexed: false},
    ],
  },
] as const;
