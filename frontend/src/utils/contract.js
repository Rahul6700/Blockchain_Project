import { ethers } from "ethers";

import deployedAddr from "./deployedAddress.json";
const CONTRACT_ADDRESS = deployedAddr.address;

// State machine: Reported(0) -> Claimed(1) -> HandoffPending(2) -> Returned(3)
const CONTRACT_ABI = [
  // ── State-transition functions ─────────────────────────────────────────────
  "function reportItem(string _description, bytes32[] _featureHashes, uint256 _threshold) returns (bytes32)",
  "function claimItem(bytes32 _itemId, string[] _features) returns (bool)",

  // Selective reopen: reporter unblocks one specific failed claimant (1 more attempt)
  "function reopenForClaimant(bytes32 _itemId, address _claimant)",

  // Two-step handoff
  "function confirmHandoff(bytes32 _itemId)",
  "function confirmReceipt(bytes32 _itemId)",

  // Mutual cancel (HandoffPending only)
  "function requestCancelHandoff(bytes32 _itemId)",
  "function approveCancelHandoff(bytes32 _itemId)",

  // ── View functions ─────────────────────────────────────────────────────────
  // Note: status is now uint8 with 4 values: 0=Reported,1=Claimed,2=HandoffPending,3=Returned
  // handoffAt replaces the old claimRound field
  "function getItem(bytes32 _itemId) view returns (bytes32 itemId, address reporter, address claimant, string description, uint256 threshold, uint256 featureCount, uint8 status, uint256 reportedAt, uint256 claimedAt, uint256 handoffAt, uint256 returnedAt)",

  // Claimant management (reporter's view)
  "function getItemClaimants(bytes32 _itemId) view returns (address[])",
  "function getClaimantInfo(bytes32 _itemId, address _claimant) view returns (uint256 failedAttempts, bool blocked, uint256 reopensUsed, uint256 reopensRemaining)",

  // Handoff / cancel info
  "function getHandoffInfo(bytes32 _itemId) view returns (bool hasPendingCancel, address cancelRequester, uint256 cancelRequestedAt, uint256 totalCancels)",
  "function getCancelRecord(bytes32 _itemId, uint256 _index) view returns (address requester, uint256 requestedAt, bool approved, address approver, uint256 approvedAt)",
  "function getCancelCount(bytes32 _itemId) view returns (uint256)",

  // Constant
  "function MAX_REOPENS_PER_CLAIMANT() view returns (uint256)",

  // General
  "function getFeatureHashes(bytes32 _itemId) view returns (bytes32[])",
  "function getItemCount() view returns (uint256)",
  "function getItemIdAtIndex(uint256 _index) view returns (bytes32)",
  "function getClaimHistoryCount() view returns (uint256)",
  "function getClaimAttempt(uint256 _index) view returns (address claimant, bytes32 itemId, bool success, uint256 matchCount, uint256 timestamp)",
  "function itemIds(uint256) view returns (bytes32)",

  // ── Events ─────────────────────────────────────────────────────────────────
  "event ItemReported(bytes32 indexed itemId, address indexed reporter, string description, uint256 timestamp)",
  "event ClaimSubmitted(bytes32 indexed itemId, address indexed claimant, bool success, uint256 matchCount, uint256 threshold, uint256 timestamp)",
  "event ItemClaimed(bytes32 indexed itemId, address indexed claimant, uint256 timestamp)",
  "event ClaimantReopened(bytes32 indexed itemId, address indexed reporter, address indexed claimant, uint256 reopensRemaining, uint256 timestamp)",
  "event HandoffConfirmed(bytes32 indexed itemId, address indexed reporter, uint256 timestamp)",
  "event ReceiptConfirmed(bytes32 indexed itemId, address indexed claimant, uint256 timestamp)",
  "event CancelHandoffRequested(bytes32 indexed itemId, address indexed requester, uint256 timestamp)",
  "event CancelHandoffApproved(bytes32 indexed itemId, address indexed requester, address indexed approver, uint256 timestamp)",
];

export const getProvider = () => {
  if (!window.ethereum) throw new Error("MetaMask not installed");
  return new ethers.BrowserProvider(window.ethereum);
};

export const getContract = async () => {
  const provider = getProvider();
  const signer = await provider.getSigner();
  return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
};

export const getReadOnlyContract = () => {
  const provider = getProvider();
  return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
};

export const checkContractDeployed = async () => {
  try {
    const provider = getProvider();
    const code = await provider.getCode(CONTRACT_ADDRESS);
    return code !== "0x";
  } catch {
    return false;
  }
};

export { CONTRACT_ADDRESS, CONTRACT_ABI };
